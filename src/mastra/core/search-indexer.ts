/**
 * Vector search indexer for the Dome vault.
 * Handles embedding and indexing notes for semantic search.
 */

import fs from "node:fs/promises";
import matter from "gray-matter";
import { join } from "node:path";
import { PgVector } from '@mastra/pg';
import { openai } from "@ai-sdk/openai";
import { embedMany } from "ai";
import { MDocument } from "@mastra/rag";
import { listNotes } from "./notes.js";
import { config } from './config.js';

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

  console.log(`Starting ${mode} indexing...`);

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

  console.log(`Indexing complete: ${records.length} notes processed`);
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
