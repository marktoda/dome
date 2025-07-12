# Design Doc – `searchNotes` Semantic Search Tool

## 1 Goals

* **Natural‑language recall** – Let users find notes by meaning, not exact words.
* **Zero‑friction addition** – Add one self‑contained Mastra tool; no breaking changes to existing `list/get/write` APIs.
* **Local‑first** – Run entirely on the user’s machine or self‑hosted Postgres; no external SaaS beyond OpenAI embeddings.

---

## 2 High‑Level Approach

```
query (text) ──► embed ► similarity search (PgVector) ──► top‑k chunks
                                    ▲
                offline cron ──► embed notes ▲
```

* **Indexing path**

  1. Scan vault for `.md` files (reuse `fast-glob`).
  2. Chunk each note (e.g., 256–512 tokens, 20 token overlap).
  3. Generate embeddings with `text-embedding-3-small`.
  4. Upsert vectors + metadata (`notePath`, `chunkText`, `heading?`, `tags`) into a PgVector index `notes_vectors`.
  5. Store `lastModified` → re‑embed only changed notes.

* **Query path**

  1. Tool receives `{ query: string, k?: number }`.
  2. Embed query.
  3. `SELECT chunk_text, note_path, score FROM notes_vectors ORDER BY vector <-> $query LIMIT k`.
  4. Stream top‑k chunks to the agent; agent may chain a `getNoteTool` call to fetch complete note.

---

## 3 New Tool Spec

```ts
// tools/searchNotesTool.ts
input: { query: string; k?: number /* default 6 */ }
output: {
  notePath: string;
  score: number;        // cosine distance
  excerpt: string;      // chunk text (trimmed)
  tags?: string[];
}[]
```

*Implements `createVectorQueryTool` from **@mastra/rag***.
Returned objects are small and directly suitable for constructing a RAG prompt.

---

## 4 Agent Integration

```ts
import { createVectorQueryTool } from "@mastra/rag";
const searchNotesTool = createVectorQueryTool({
  vectorStoreName: "pgVector",
  indexName: "notes_vectors",
  model: openai.embedding("text-embedding-3-small"),
});

export const notesAgent = new Agent({
  name: "Notes Assistant",
  instructions: `You manage a markdown vault.
    Use searchNotesTool first when the user asks for information retrieval.
    Cite note paths in your answers. Do *not* hallucinate content.`,
  model: openai("gpt-4o-mini"),
  tools: { listNotesTool, getNoteTool, writeNoteTool, searchNotesTool },
});
```

Agent behavior:

1. **Retrieval first** – When the user asks “Where did I write about X?”, call `searchNotesTool`.
2. **Drill‑down** – If needed, follow up with `getNoteTool` to quote full sections or append.

---

## 5 Vector Store Setup

```ts
const pgVector = new PgVector({ connectionString: process.env.POSTGRES_CONNECTION_STRING! });
await pgVector.createIndex({
  indexName: "notes_vectors",
  dimension: 1536,
});
```

### Metadata schema (`jsonb`)

```json5
{
  "notePath": "projects/architecture-notes.md",
  "tags": ["architecture", "design"],
  "modified": "2025-07-12T09:30:00Z"
}
```

---

## 6 Indexing Script

`src/indexNotes.ts`

```ts
const vaultPath = process.env.DOME_VAULT_PATH ?? "~/dome";
const mdFiles = await fg("**/*.md", { cwd: vaultPath });

for (const file of mdFiles) {
  if (unchangedSinceLastRun(file)) continue;

  const note = await fs.readFile(file, "utf8");
  const chunks = chunkMarkdown(note);          // size 256, overlap 20
  const { embeddings } = await embedMany({
    model: openai.embedding("text-embedding-3-small"),
    values: chunks.map(c => c.text),
  });

  await pgVector.upsert({
    indexName: "notes_vectors",
    vectors: embeddings,
    metadata: chunks.map(c => ({ notePath: file, ...c.meta })),
  });
}
```

*Run via `npm run index:notes` or a daily cron.*

---

## 7 Environment Variables

```
OPENAI_API_KEY=
POSTGRES_CONNECTION_STRING=
DOME_VAULT_PATH=~/dome
EMBED_CHUNK_SIZE=256        # optional tuning
```

---

## 8 Error Handling

| Failure                         | Strategy                                                                 |
| ------------------------------- | ------------------------------------------------------------------------ |
| Postgres down                   | Tool returns empty array, agent apologizes & falls back to keyword scan. |
| Embedding API rate‑limit        | Exponential back‑off; skip file after 3 retries.                         |
| Vault growth > 50 MB embeddings | Warn user; suggest pruning or local embedding model.                     |

---

## 9 Testing Checklist

1. **Exact match:** query “project-review” → top result path matches note.
2. **Semantic:** query “system resilience” returns chunks discussing “graceful degradation”.
3. **Freshness:** edit a note, rerun index, verify new content searchable.
4. **Latency:** end‑to‑end query < 1 s for 10 k notes on local machine.

---

## 10 Future Enhancements

* **Hybrid rank (BM25 + vectors)** to boost recall.
* **On‑device embeddings** (e.g., `ggml` models) for offline privacy.
* **Real‑time streaming index** triggered by `writeNoteTool` success.
* **UI helpers** – VS Code extension surfacing `searchNotes` inline.

---

### Effort Estimate

| Task                             | Time            |
| -------------------------------- | --------------- |
| PgVector setup & migrations      | 2 h             |
| Indexer script                   | 4 h             |
| `searchNotesTool` implementation | 3 h             |
| Agent integration & prompts      | 2 h             |
| Tests + docs                     | 2 h             |
| **Total**                        | **\~1 workday** |

---

By cleanly isolating semantic search in a single Mastra tool and leveraging the same embedding workflow shown in the RAG tutorial, we enhance the notes system without disturbing existing workflows, while keeping the codebase minimal and comprehensible.

