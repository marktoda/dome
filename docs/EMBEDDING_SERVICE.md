# Constellation 📡

**Async Embedding & Vector Search Service for Dome**

---

## 1 Overview

Constellation is a dedicated Cloudflare Worker that:

- **Consumes** raw‑text jobs from a Workers Queue, turns them into vector
  embeddings with Workers AI, and upserts them into the shared Vectorize index.
- **Exposes** a **typed RPC interface** (service binding) so any other Worker
  (API, cron importers, CLI) can embed on demand, run vector/text queries, or
  pull quick stats — without speaking HTTP or knowing the AI/key details.

This removes heavy AI calls from user‑facing code, provides bulk‑loading
capacity (GitHub, Notion, …), and gives one central place to evolve our
model/metadata scheme.

```
┌───────────────┐         enqueue           ┌───────────────┐
│  API Worker   │──────────────────────────▶│  EMBED_QUEUE  │
│  GitHub Cron  │                           └───────────────┘
│  Notion Cron  │                                 ▲
└───────┬───────┘                                 │ batch
        │ service RPC                             │
        ▼                                         │
┌───────────────────────────────────────────────────────────────┐
│             Constellation Worker (service “embedder”)        │
│                                                               │
│   queue(jobs)  ─►  embedBatch()  ─►  Workers AI  ─► Vectorize │
│                               ▲               │              │
│     RPC: query(), stats()  ───┘               └───► logs/metrics
└───────────────────────────────────────────────────────────────┘
```

---

## 2 Goals & Non‑Goals

|                                                    | ✔ In scope | ✖ Out |
| -------------------------------------------------- | ---------- | ----- |
| Async, high‑throughput ingestion (queue consumer). | ✔          |       |
| Bulk back‑fills (GitHub repo, Notion export).      | ✔          |       |
| Single RPC surface (`embed`, `query`, `stats`).    | ✔          |       |
| Equality‑filter search on Vectorize metadata.      | ✔          |       |
| Re‑ranking, summarisation, hybrid BM25 pipelines.  |            | ✖     |

---

## 3 Data Contracts

### 3.1 Queue Message (`EmbedJob`)

```ts
interface EmbedJob {
  userId: string;
  noteId: string;
  text: string; // ≤ 8 kB preferred
  created: number; // ms since epoch
  version: number; // embedding version
}
```

### 3.2 Vector Metadata (`NoteVectorMeta`)

```ts
{
  userId: string;
  noteId: string;
  createdAt: number; // s since epoch
  version: number;
}
```

Metadata indexes (one‑time):

```bash
wrangler vectorize create-metadata-index notes_index \
  --property-name userId    --type string
wrangler vectorize create-metadata-index notes_index \
  --property-name noteId    --type string
wrangler vectorize create-metadata-index notes_index \
  --property-name version   --type number
```

---

## 4 Constellation Worker Implementation

```ts
// src/constellation.ts
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { VectorMetadata } from '../common/types';

export class Constellation extends WorkerEntrypoint {
  /* ---------------- Queue Consumer ---------------- */
  async queue(batch: MessageBatch<EmbedJob>, env: Env) {
    const jobs = batch.messages.map(m => m.body);

    // 1. preprocess text
    const texts = jobs.map(j => preprocess(j.text));

    // 2. embed (20 per call max)
    const resp = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text: texts });
    const vectors = resp.data.map((vec: number[], i: number) => ({
      id: `note:${jobs[i].noteId}`,
      values: vec,
      metadata: {
        userId: jobs[i].userId,
        noteId: jobs[i].noteId,
        createdAt: Math.floor(jobs[i].created / 1000),
        version: jobs[i].version,
      } satisfies VectorMetadata,
    }));
    await env.VECTORIZE.upsert(vectors);
  }

  /* ---------------- RPC Methods ---------------- */
  /** Embed a single note immediately (rare). */
  public async embed(env: Env, job: EmbedJob): Promise<void> {
    await this.queue({ messages: [{ body: job }], retryAll: () => {} } as any, env);
  }

  /** Vector/text similarity search. */
  public async query(env: Env, text: string, filter: Partial<VectorMetadata>, topK = 10) {
    return await env.VECTORIZE.query(text, { topK, filter });
  }

  /** Lightweight health/stat endpoint. */
  public async stats(env: Env) {
    const info = await env.VECTORIZE.info();
    return { vectors: info.vectorCount, dimension: info.dimensions };
  }
}

export default new Constellation();
```

### 4.1 wrangler.toml (Constellation)

```toml
name = "constellation"
main = "src/constellation.ts"

[[queues.consumers]]
queue = "EMBED_QUEUE"
max_batch_size = 10

vectorize_binding = "VECTORIZE"
ai_binding = "AI"
```

---

## 5 Caller Workers

### 5.1 Binding

```toml
[[services]]
binding   = "CONSTELLATION"
service   = "constellation"
environment = "production"
```

### 5.2 Usage

```ts
// enqueue for async embed
await env.QUEUE.send('EMBED_QUEUE', {
  userId,
  noteId,
  text,
  created: Date.now(),
  version: 1,
} satisfies EmbedJob);

// direct search
const res = await env.CONSTELLATION.query(queryText, { userId }, 10);
```

RPC stubs are statically typed via `Service<typeof Constellation>`.

---

## 6 Operational Guidelines

| Aspect            | Recommendation                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Throughput**    | One consumer can embed ~300–500 jobs/sec; scale by increasing `queues.concurrency` or deploying additional instances. |
| **Back‑pressure** | On AI 429, call `batch.retryAll(delay)` to re‑queue.                                                                  |
| **Monitoring**    | Emit logs: `embed.ms`, `upsert.ms`, queue lag, failures → Cloudflare Logs/Grafana.                                    |
| **DLQ**           | Configure second queue `EMBED_DEAD` and `batch.sendToDeadLetter`.                                                     |
| **Model upgrade** | Bump `version` in jobs; Constellation upserts new vectors under same ID (or new ID with suffix).                      |
| **Local dev**     | `wrangler dev --queue-consumer` for Constellation; producers use `wrangler queues publish`.                           |

---

## 7 Migration Plan

1. **Deploy Constellation** Worker; verify `/stats` via RPC.
2. Update API & import Workers to **enqueue** instead of inline embed.
3. Replace any Vectorize `fetch` calls with `env.CONSTELLATION.query`.
4. Monitor queue depth; adjust batch size/concurrency.
5. Remove legacy embedding code paths.

---

### TL;DR

- **Constellation** Worker = queue consumer **+** RPC service.
- Producers push `EmbedJob` messages; Constellation batches, embeds, upserts.
- Other Workers call `env.CONSTELLATION.query()` or `.stats()` through native
  service binding—no HTTP, full type safety.
