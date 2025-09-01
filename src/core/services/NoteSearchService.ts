/**
 * Vector search indexer for the Dome vault.
 * Handles embedding and indexing notes for semantic search.
 */

import fs from 'node:fs/promises';
import { frontmatterService } from './FrontmatterService.js';
import { join } from 'node:path';
import { PgVector } from '@mastra/pg';
import { embedText, embedChunks } from '../utils/embedding.js';
import { MDocument } from '@mastra/rag';
import { NoteService } from './NoteService.js';
import logger from '../utils/logger.js';
import { config } from '../utils/config.js';

// Configuration
const EMBEDDING_DIMENSION = 1536; // text-embedding-3-small

export class NoteSearchService {
  private store: PgVector;

  constructor(private notes: NoteService) {
    this.store = new PgVector({ connectionString: config.POSTGRES_URI });
  }

  /**
   * Convenience: embed a text query and run vector search.
   */
  async searchNotes(query: string, k = 10): Promise<SearchResult[]> {
    try {
      const queryVector = await embedText(query);
      const results = await this.store.query({
        indexName: config.DOME_INDEX_NAME,
        queryVector,
        topK: k,
      });

      return results.map(result => ({
        id: result.id,
        score: result.score,
        metadata: result.metadata as VectorMeta,
      }));
    } catch (err) {
      logger.error(`searchNotes failed: ${err}`);
      return [];
    }
  }

  /**
   * Index a single note – called by after-save hook.
   * Fast path that avoids scanning the whole vault.
   */
  async indexSingleNote(notePath: string): Promise<void> {
    try {
      await this.ensureTable();
      const records = await fileToVectorRecords(notePath);
      await this.store.upsert({
        indexName: config.DOME_INDEX_NAME,
        vectors: records.map(r => r.vector),
        metadata: records.map(r => r.metadata),
        ids: records.map(r => r.id),
      });
      logger.debug(`[vector] indexed ${notePath}`);
    } catch (err) {
      logger.error(`Error indexing note ${notePath}: ${err}`);
    }
  }

  /**
   * Index all notes in the vault
   * @param mode - 'full' for complete reindex, 'incremental' for updates only
   * @returns Number of notes indexed
   */
  async indexNotes(mode: 'full' | 'incremental' = 'incremental'): Promise<number> {
    await this.ensureTable();

    // Clear existing vectors when performing a full reindex
    if (mode === 'full') {
      try {
        await this.store.pool.query(`DELETE FROM ${config.DOME_INDEX_NAME}`);
        logger.debug('Cleared existing vectors for full reindex');
      } catch (err) {
        logger.error(`Failed to clear existing vectors: ${err}`);
      }
    }

    logger.debug(`Starting ${mode} indexing...`);

    // Get all notes
    const notes = await this.notes.listNotes();
    if (notes.length === 0) {
      logger.info('No notes to index');
      return 0;
    }

    const records = await Promise.all(notes.map(note => fileToVectorRecords(note.path)));
    await this.store.upsert({
      indexName: config.DOME_INDEX_NAME,
      vectors: records.flatMap(r => r.map(rec => rec.vector)),
      metadata: records.flatMap(r => r.map(rec => rec.metadata)),
      ids: records.flatMap(r => r.map(rec => rec.id)),
    });

    logger.debug(`Indexing complete: ${records.length} notes processed`);
    return records.length;
  }

  /**
   * Ensure the vector table exists
   * @param store - Vector store instance
   * @param records - Initial records to create table with
   */
  async ensureTable(): Promise<void> {
    // TODO: only create if needed
    await this.store.createIndex({
      indexName: config.DOME_INDEX_NAME,
      dimension: EMBEDDING_DIMENSION,
    });
  }
}

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
  const raw = await fs.readFile(fullPath, 'utf8');
  const parsed = frontmatterService.parse(raw);
  const { data, content } = parsed;

  const titleText = data.title ?? relativePath.replace(/\.md$/, '').replace(/[-_]/g, ' ');

  // Chunk the markdown content
  const doc = MDocument.fromMarkdown(content);
  const chunks = await doc.chunk({
    strategy: 'markdown',
    size: 256,
    overlap: 20,
  });

  if (chunks.length === 0) return [];

  // Generate embeddings for all chunks *and* the title snippet
  const textsForEmbedding = [titleText, ...chunks.map(c => c.text)];
  const embeddings = await embedChunks(textsForEmbedding);

  const stat = await fs.stat(fullPath);
  const modified = stat.mtime.toISOString();

  // First embedding corresponds to the title.
  const titleRecord: VectorRecord = {
    id: `${relativePath}_title`,
    vector: embeddings[0],
    metadata: {
      notePath: relativePath,
      text: titleText,
      tags: Array.isArray(data.tags) ? data.tags : ['_untagged'],
      modified,
      isTitle: true,
    },
  };

  // Map the rest to chunks (shift by 1)
  const chunkRecords = embeddings.slice(1).map((embedding: number[], i: number) => ({
    id: `${relativePath}_${i}`,
    vector: embedding,
    metadata: {
      notePath: relativePath,
      text: chunks[i].text,
      tags: Array.isArray(data.tags) ? data.tags : ['_untagged'],
      modified,
      ...chunks[i].metadata,
    },
  }));

  return [titleRecord, ...chunkRecords];
}
