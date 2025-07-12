import fs from "node:fs/promises";
import matter from "gray-matter";
import { join } from "node:path";
import { LanceVectorStore } from "@mastra/lance";
import { openai } from "@ai-sdk/openai";
import { embedMany } from "ai";
import { MDocument } from "@mastra/rag";
import { listNotes } from "./notes.js";

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------
const vaultPath = process.env.DOME_VAULT_PATH ?? `${process.env.HOME}/dome`;
const dbPath = process.env.LANCE_DB_PATH ?? `${vaultPath}/.vector_db`;
const tableName = "notes_vectors";          // Lance table
const indexName = "vector";                 // column that stores embeddings
const dimension = 1536;                      // text‑embedding‑3‑small

// ---------------------------------------------------------------------------
// LanceDB store singleton
// ---------------------------------------------------------------------------
let store: LanceVectorStore | null = null;
export async function getVectorStore(): Promise<LanceVectorStore> {
  if (!store) {
    store = await LanceVectorStore.create(dbPath);
  }
  return store;
}

// ---------------------------------------------------------------------------
// Helper: embed + chunk a Markdown file → Lance records
// ---------------------------------------------------------------------------
async function fileToVectorRecords(relativePath: string) {
  const fullPath = join(vaultPath, relativePath);
  const raw = await fs.readFile(fullPath, "utf8");
  const { data, content } = matter(raw);

  // Mastra‑aware chunking
  const doc = MDocument.fromMarkdown(content);
  const chunks = await doc.chunk({ strategy: "markdown", size: 256, overlap: 20 });
  if (chunks.length === 0) return [];

  // OpenAI embeddings
  const { embeddings } = await embedMany({
    model: openai.embedding("text-embedding-3-small"),
    values: chunks.map(c => c.text),
  });

  const stat = await fs.stat(fullPath);
  const modified = stat.mtime.toISOString();

  return embeddings.map((embedding, i) => ({
    id: `${relativePath}_${i}`,
    vector: embedding,                       // Lance column
    metadata: {
      notePath: relativePath,
      text: chunks[i].text,
      tags: (Array.isArray(data.tags) && data.tags.length)
        ? data.tags
        : ["_placeholder_"],      // ensure non‑empty for schema inference
      modified,
      ...chunks[i].metadata,
    },
  }));
}

// ---------------------------------------------------------------------------
// Ensure table exists (create once, otherwise just open it)
// ---------------------------------------------------------------------------
async function ensureTable(
  store: LanceVectorStore,
  records: any[]
) {
  const tables = await store.listTables?.();          // not in all SDKs
  const exists = Array.isArray(tables) && tables.includes(tableName);

  if (!exists) {
    await store.createTable(tableName, records, { existOk: true }); // ← tolerates re-runs
    console.log(`✅ Table '${tableName}' created with ${records.length} vectors`);
  }
}

// ---------------------------------------------------------------------------
// Index / re-index notes
// ---------------------------------------------------------------------------
export async function indexAllNotes(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY env var missing");

  const vectorStore = await getVectorStore();
  const notes = await listNotes();               // your helper

  const BATCH_SIZE = 5;
  let vectorsInserted = 0;

  // ⇢  gather records batch-wise
  for (let i = 0; i < notes.length; i += BATCH_SIZE) {
    const batch = notes.slice(i, i + BATCH_SIZE);
    const batchRecords = (await Promise.all(batch.map(n => fileToVectorRecords(n.path)))).flat();
    if (batchRecords.length === 0) continue;

    // • only the very first batch may need to create the table
    if (i === 0) await ensureTable(vectorStore, batchRecords);

    // • upsert always safe – duplicates are overwritten
    await vectorStore.upsert({
      tableName,
      indexName,
      vectors: batchRecords.map(r => r.vector),
      metadata: batchRecords.map(r => r.metadata),
      ids: batchRecords.map(r => r.id),
    });
    vectorsInserted += batchRecords.length;
    console.log(`🔄 Upserted ${batchRecords.length} chunks from [${batch.map(n => n.path).join(", ")}]`);
  }

  // build the HNSW index once (skip if present)
  const existingIdx = await vectorStore.listIndexes?.();

  if (!existingIdx?.includes(`${indexName}_idx`)) {
    await vectorStore.createIndex({ tableName, indexName, dimension, indexConfig: { type: "hnsw" } });
    console.log(`🔧 HNSW index built on column '${indexName}'`);
  }

  console.log(`🎉 Finished indexing ${vectorsInserted} vectors across ${notes.length} files.`);
}

// ---------------------------------------------------------------------------
// Public helper: semantic search
// ---------------------------------------------------------------------------
export async function searchSimilarNotes(queryEmbedding: number[], topK = 6) {
  const vectorStore = await getVectorStore();
  return vectorStore.query({ includeAllColumns: true, tableName, indexName, queryVector: queryEmbedding, topK });
}

