/**
 * Vector search indexer for the Dome vault.
 * Handles embedding and indexing notes for semantic search.
 */

import fs from "node:fs/promises";
// chokidar ships its own types from v3 onward. If the type package isn't present
// in the repo we still want the code to compile, so we suppress the lint error.
// @ts-ignore – compiled code will use default export; we also import the type.
import chokidar, { FSWatcher } from "chokidar";
import matter from "gray-matter";
import { join } from "node:path";
import { PgVector } from '@mastra/pg';
import { embedChunks } from "./embedding.js";
import { MDocument } from "@mastra/rag";
import { listNotes } from "./notes.js";
import { config } from './config.js';
import { noteEvents } from './events.js';

// Configuration
const store = new PgVector({ connectionString: config.POSTGRES_URI });
const EMBEDDING_DIMENSION = 1536; // text-embedding-3-small

/**
 * Vector record structure for LanceDB
 */
interface VectorRecord {
  id: string;
  vector: number[];
  metadata: VectorMeta;
}

interface VectorMeta {
  notePath: string;
  text: string;
  tags: string[];
  modified: string;
  [key: string]: any;

}

/**
 * Search result from vector similarity
 */
interface SearchResult {
  id: string;
  score: number;
  metadata?: VectorMeta;
}

/**
 * Convert a markdown file to vector records
 * @param relativePath - Path relative to vault root
 * @returns Array of vector records for the file's chunks
 */
async function fileToVectorRecords(relativePath: string): Promise<VectorRecord[]> {
  const fullPath = join(config.DOME_VAULT_PATH, relativePath);
  const raw = await fs.readFile(fullPath, "utf8");
  const { data, content } = matter(raw);

  // Chunk the markdown content
  const doc = MDocument.fromMarkdown(content);
  const chunks = await doc.chunk({
    strategy: "markdown",
    size: 256,
    overlap: 20
  });

  if (chunks.length === 0) return [];

  // Generate embeddings for all chunks (with cache)
  const embeddings = await embedChunks(chunks.map(c => c.text));

  const stat = await fs.stat(fullPath);
  const modified = stat.mtime.toISOString();

  return embeddings.map((embedding: number[], i: number) => ({
    id: `${relativePath}_${i}`,
    vector: embedding,
    metadata: {
      notePath: relativePath,
      text: chunks[i].text,
      tags: Array.isArray(data.tags) ? data.tags : ["_untagged"],
      modified,
      ...chunks[i].metadata,
    },
  }));
}

/**
 * Ensure the vector table exists
 * @param store - Vector store instance
 * @param records - Initial records to create table with
 */
async function ensureTable(): Promise<void> {
  // TODO: only create if needed
  await store.createIndex({
    indexName: config.DOME_INDEX_NAME,
    dimension: EMBEDDING_DIMENSION,
  });
}

/**
 * Index all notes in the vault
 * @param mode - 'full' for complete reindex, 'incremental' for updates only
 * @returns Number of notes indexed
 */
export async function indexNotes(
  mode: "full" | "incremental" = "incremental"
): Promise<number> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY not set - skipping vector indexing");
    return 0;
  }
  await ensureTable();

  console.debug(`Starting ${mode} indexing...`);

  // Get all notes
  const notes = await listNotes();
  if (notes.length === 0) {
    console.log("No notes to index");
    return 0;
  }

  const records = await Promise.all(notes.map(note => fileToVectorRecords(note.path)));
  await store.upsert({
    indexName: config.DOME_INDEX_NAME,
    vectors: records.flatMap(r => r.map(rec => rec.vector)),
    metadata: records.flatMap(r => r.map(rec => rec.metadata)),
    ids: records.flatMap(r => r.map(rec => rec.id)),
  });

  console.debug(`Indexing complete: ${records.length} notes processed`);
  return records.length;
}

/**
 * Search for similar notes using vector similarity
 * @param queryVector - Query vector embedding
 * @param k - Number of results to return
 * @returns Array of search results
 */
export async function searchSimilarNotes(
  queryVector: number[],
  k: number = 6
): Promise<SearchResult[]> {
  try {
    const results = await store
      .query({ indexName: config.DOME_INDEX_NAME, queryVector, topK: k, });

    return results.map(result => ({
      id: result.id,
      score: result.score,
      metadata: result.metadata as VectorMeta,
    }));
  } catch (error) {
    console.error("Error searching notes:", error);
    return [];
  }
}

/**
 * Delete all vectors belonging to a specific note.
 * NOTE: Depends on PgVector API; if unavailable this becomes a no-op and logs a warning.
 */
async function deleteVectorsByNotePath(notePath: string): Promise<void> {
  try {
    // Attempt naive metadata-based delete (pseudo API – adjust if needed).
    if (typeof (store as any).deleteByMetadata === 'function') {
      await (store as any).deleteByMetadata({
        indexName: config.DOME_INDEX_NAME,
        where: { notePath },
      });
    } else {
      // Fallback: raw query – assumes "metadata" JSONB column with notePath key
      const pool = (store as any).pool || (store as any).client;
      if (pool && typeof pool.query === 'function') {
        await pool.query(
          `DELETE FROM ${config.DOME_INDEX_NAME} WHERE metadata->>'notePath' = $1`,
          [notePath],
        );
      } else {
        console.warn('[indexer] deleteVectorsByNotePath: delete not supported by store implementation');
      }
    }
  } catch (err) {
    console.error('Error deleting vectors for', notePath, err);
  }
}

interface IndexingState {
  isRunning: boolean;
  lastIndexTime: number;
  pendingFiles: Set<string>;
  indexingPromise: Promise<void> | null;
  showStatus: boolean;
  silentMode: boolean;
}

class BackgroundIndexer {
  private state: IndexingState = {
    isRunning: false,
    lastIndexTime: 0,
    pendingFiles: new Set(),
    indexingPromise: null,
    showStatus: true,
    silentMode: false
  };

  private readonly INDEXING_INTERVAL = 30000; // 30 seconds
  private readonly EVENT_DEBOUNCE_MS = 1500;

  private changed = new Set<string>();
  private deleted = new Set<string>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;

  /**
   * Start background indexing during chat session
   */
  async startBackgroundIndexing(): Promise<void> {
    if (this.state.isRunning) return;

    this.state.isRunning = true;
    if (this.state.showStatus) {
      this.logStatus('🔍 Background indexing started');
    }

    // Wire event listeners (internal note events)
    noteEvents.on('note:changed', (p: string) => this.queueNoteChange(p));
    noteEvents.on('note:deleted', (p: string) => this.queueNoteDeletion(p));

    // Set up filesystem watcher for external editors
    this.watcher = chokidar.watch(`${config.DOME_VAULT_PATH}/**/*.md`, {
      ignoreInitial: true,
    });

    this.watcher
      .on('add', (p: string) => this.handleFsEvent(p, 'changed'))
      .on('change', (p: string) => this.handleFsEvent(p, 'changed'))
      .on('unlink', (p: string) => this.handleFsEvent(p, 'deleted'));

    // Trigger an initial full index in the background
    this.state.indexingPromise = this.performBackgroundIndexing();
    this.state.indexingPromise.catch(() => {/* already logged */ });
  }

  /**
   * Stop background indexing
   */
  async stopBackgroundIndexing(): Promise<void> {
    this.state.isRunning = false;

    // Clean up watcher
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    // Wait for any ongoing indexing to complete
    if (this.state.indexingPromise) {
      await this.state.indexingPromise;
    }

    if (!this.state.silentMode) {
      console.log('🔍 Background indexing stopped');
    }
  }

  /**
   * Check if indexing is needed and schedule it
   */
  private async scheduleIndexingIfNeeded(): Promise<void> {
    if (!this.state.isRunning || this.state.indexingPromise) return;

    try {
      const needsIndexing = await this.checkIfIndexingNeeded();
      if (needsIndexing) {
        this.state.indexingPromise = this.performBackgroundIndexing();
        await this.state.indexingPromise;
        this.state.indexingPromise = null;
      }
    } catch (error) {
      if (!this.state.silentMode) {
        console.error('Background indexing check failed:', error);
      }
      this.state.indexingPromise = null;
    }
  }

  /**
   * Set up periodic indexing checks
   */
  private schedulePeriodicIndexing(): void {
    if (!this.state.isRunning) return;

    setTimeout(async () => {
      await this.scheduleIndexingIfNeeded();
      if (this.state.isRunning) {
        this.schedulePeriodicIndexing();
      }
    }, this.INDEXING_INTERVAL);
  }

  /**
   * Check if indexing is needed based on file modifications
   */
  private async checkIfIndexingNeeded(): Promise<boolean> {
    try {
      const notes = await listNotes();
      const dbPath = process.env.LANCE_DB_PATH ?? `${config.DOME_VAULT_PATH}/.vector_db`;

      // Check if vector DB exists
      try {
        await fs.access(dbPath);
      } catch {
        return true; // DB doesn't exist, need initial indexing
      }

      // Check if any notes are newer than last index time
      for (const note of notes) {
        const fullPath = join(config.DOME_VAULT_PATH, note.path);
        try {
          const stat = await fs.stat(fullPath);
          if (stat.mtime.getTime() > this.state.lastIndexTime) {
            return true;
          }
        } catch {
          // File might have been deleted, continue checking others
          continue;
        }
      }

      return false;
    } catch (error) {
      if (!this.state.silentMode) {
        console.error('Error checking indexing needs:', error);
      }
      return false;
    }
  }

  /**
   * Perform the actual background indexing
   */
  private async performBackgroundIndexing(): Promise<void> {
    try {
      noteEvents.emit('index:progress', { type: 'progress', progress: 0 });
      if (this.state.showStatus) {
        this.logStatus('🔄 Indexing notes...');
      }
      const processed = await indexNotes();
      this.state.lastIndexTime = Date.now();
      if (this.state.showStatus) {
        this.logStatus('✅ Background indexing completed');
      }
      noteEvents.emit('index:progress', { type: 'progress', progress: 100, noteCount: processed, indexedCount: processed });
      noteEvents.emit('index:complete', {
        type: 'complete',
        noteCount: processed,
      });
    } catch (error) {
      if (!this.state.silentMode) {
        console.error('❌ Background indexing failed:', error);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Event-driven incremental indexing helpers
  // ---------------------------------------------------------------------

  private handleFsEvent(absPath: string, kind: 'changed' | 'deleted'): void {
    // Convert to relative path within vault
    const relPath = absPath.replace(`${config.DOME_VAULT_PATH}/`, '');
    if (kind === 'changed') {
      this.queueNoteChange(relPath);
    } else {
      this.queueNoteDeletion(relPath);
    }
  }

  private queueNoteChange(path: string): void {
    this.changed.add(path);
    this.scheduleDebouncedIncrementalIndex();
  }

  private queueNoteDeletion(path: string): void {
    this.deleted.add(path);
    this.scheduleDebouncedIncrementalIndex();
  }

  private scheduleDebouncedIncrementalIndex(): void {
    if (this.debounceTimer) return; // already scheduled
    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      await this.performIncrementalIndex();
    }, this.EVENT_DEBOUNCE_MS);
  }

  private async performIncrementalIndex() {
    if (!this.state.isRunning) return;

    const changed = Array.from(this.changed);
    const deleted = Array.from(this.deleted);
    this.changed.clear();
    this.deleted.clear();

    try {
      // Delete first to avoid duplicate IDs
      for (const p of deleted) {
        await deleteVectorsByNotePath(p);
      }

      if (changed.length) {
        const recordsArray = await Promise.all(changed.map(fileToVectorRecords));
        const flat = recordsArray.flat();
        if (flat.length) {
          await store.upsert({
            indexName: config.DOME_INDEX_NAME,
            vectors: flat.map(r => r.vector),
            metadata: flat.map(r => r.metadata),
            ids: flat.map(r => r.id),
          });
        }
      }
      if (this.state.showStatus) {
        this.logStatus('✅ Incremental index updated');
      }

      noteEvents.emit('index:updated', { type: 'updated' });
    } catch (err) {
      console.error('Incremental indexing failed', err);
    }
  }

  /**
   * Log status messages without disrupting chat input
   */
  private logStatus(message: string): void {
    if (this.state.silentMode) return;

    // Clear current line, print status, then restore prompt
    process.stdout.write('\r\x1b[K'); // Clear line
    console.log(message);
    process.stdout.write('> '); // Restore prompt
  }

  /**
   * Force a background index (useful for testing)
   */
  async forceIndex(): Promise<void> {
    if (this.state.indexingPromise) {
      if (!this.state.silentMode) {
        console.log('Indexing already in progress, waiting...');
      }
      await this.state.indexingPromise;
      return;
    }

    this.state.indexingPromise = this.performBackgroundIndexing();
    await this.state.indexingPromise;
    this.state.indexingPromise = null;
  }

  /**
   * Get current indexing status
   */
  getStatus(): { isRunning: boolean; isIndexing: boolean; lastIndexTime: number } {
    return {
      isRunning: this.state.isRunning,
      isIndexing: this.state.indexingPromise !== null,
      lastIndexTime: this.state.lastIndexTime
    };
  }

  /**
   * Enable or disable status messages
   */
  setStatusDisplay(show: boolean): void {
    this.state.showStatus = show;
  }

  /**
   * Enable or disable all console output (for TUI mode)
   */
  setSilentMode(silent: boolean): void {
    this.state.silentMode = silent;
  }
}

export const backgroundIndexer = new BackgroundIndexer();
