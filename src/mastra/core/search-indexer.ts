/**
 * Vector search indexer for the Dome vault.
 * Handles embedding and indexing notes for semantic search.
 */

import fs from "node:fs/promises";
import matter from "gray-matter";
import { join } from "node:path";
import { LanceVectorStore } from "@mastra/lance";
import { openai } from "@ai-sdk/openai";
import { embedMany } from "ai";
import { MDocument } from "@mastra/rag";
import { listNotes } from "./notes.js";

// Configuration
const vaultPath = process.env.DOME_VAULT_PATH ?? `${process.env.HOME}/dome`;
const dbPath = process.env.LANCE_DB_PATH ?? `${vaultPath}/.vector_db`;
const TABLE_NAME = "notes_vectors";
const EMBEDDING_DIMENSION = 1536; // text-embedding-3-small

/**
 * Vector record structure for LanceDB
 */
interface VectorRecord {
  id: string;
  vector: number[];
  metadata: {
    notePath: string;
    text: string;
    tags: string[];
    modified: string;
    [key: string]: any;
  };
}

/**
 * Search result from vector similarity
 */
interface SearchResult {
  score: number;
  metadata?: {
    notePath: string;
    text: string;
    tags?: string[];
    [key: string]: any;
  };
}

/**
 * Create a new vector store instance
 * @returns LanceDB vector store
 */
export async function createVectorStore(): Promise<LanceVectorStore> {
  return await LanceVectorStore.create(dbPath);
}

/**
 * Convert a markdown file to vector records
 * @param relativePath - Path relative to vault root
 * @returns Array of vector records for the file's chunks
 */
async function fileToVectorRecords(relativePath: string): Promise<VectorRecord[]> {
  const fullPath = join(vaultPath, relativePath);
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

  // Generate embeddings for all chunks
  const { embeddings } = await embedMany({
    model: openai.embedding("text-embedding-3-small"),
    values: chunks.map(c => c.text),
  });

  const stat = await fs.stat(fullPath);
  const modified = stat.mtime.toISOString();

  return embeddings.map((embedding, i) => ({
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
async function ensureTable(
  store: LanceVectorStore,
  records: VectorRecord[]
): Promise<void> {
  const tables = await store.listTables?.();
  const exists = Array.isArray(tables) && tables.includes(TABLE_NAME);

  if (!exists && records.length > 0) {
    await store.createTable(TABLE_NAME, records, { existOk: true });
  }
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

  console.log(`Starting ${mode} indexing...`);
  const store = await createVectorStore();
  
  // Get all notes
  const notes = await listNotes();
  if (notes.length === 0) {
    console.log("No notes to index");
    return 0;
  }

  // Convert first note to get initial records
  const firstRecords = await fileToVectorRecords(notes[0].path);
  await ensureTable(store, firstRecords);

  let indexed = 0;
  const table = await store.openTable(TABLE_NAME);

  if (mode === "full") {
    // Clear existing data
    console.log("Clearing existing index...");
    // Note: LanceDB doesn't have a clear method, would need to recreate table
  }

  // Index each note
  for (const note of notes) {
    try {
      const records = await fileToVectorRecords(note.path);
      
      if (records.length > 0) {
        // Remove old records for this note
        const idsToDelete = [];
        for (let i = 0; i < 100; i++) {
          idsToDelete.push(`${note.path}_${i}`);
        }
        
        try {
          await table.delete(`id IN (${idsToDelete.map(id => `'${id}'`).join(',')})`);
        } catch {
          // Ignore deletion errors
        }

        // Add new records
        await table.add(records);
        indexed++;
        
        if (indexed % 10 === 0) {
          console.log(`Indexed ${indexed}/${notes.length} notes...`);
        }
      }
    } catch (error) {
      console.error(`Error indexing ${note.path}:`, error);
    }
  }

  // Create vector index for fast search
  try {
    await table.createIndex({
      column: "vector",
      type: "ivf_pq",
      name: "vector_index",
      params: { nlist: Math.min(256, notes.length), nprobe: 10 },
      replace: true,
    });
  } catch (error) {
    console.error("Error creating vector index:", error);
  }

  console.log(`Indexing complete: ${indexed} notes processed`);
  return indexed;
}

/**
 * Search for similar notes using vector similarity
 * @param queryEmbedding - Query vector embedding
 * @param k - Number of results to return
 * @returns Array of search results
 */
export async function searchSimilarNotes(
  queryEmbedding: number[],
  k: number = 6
): Promise<SearchResult[]> {
  try {
    const store = await createVectorStore();
    const table = await store.openTable(TABLE_NAME);

    const results = await table
      .vectorSearch(queryEmbedding)
      .limit(k)
      .toArray();

    return results.map(result => ({
      score: result._distance || 0,
      metadata: result.metadata as any,
    }));
  } catch (error) {
    console.error("Error searching notes:", error);
    return [];
  }
}

/**
 * Get indexing statistics
 * @returns Stats about the vector index
 */
export async function getIndexStats(): Promise<{
  totalRecords: number;
  lastModified?: Date;
} | null> {
  try {
    const store = await createVectorStore();
    const tables = await store.listTables?.();
    
    if (!tables?.includes(TABLE_NAME)) {
      return null;
    }

    const table = await store.openTable(TABLE_NAME);
    const count = await table.countRows();
    
    return {
      totalRecords: count,
      lastModified: new Date(), // LanceDB doesn't track this
    };
  } catch (error) {
    console.error("Error getting index stats:", error);
    return null;
  }
}