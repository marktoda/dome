## 0 . High‑level goals

| Goal                                      | Cloudflare feature                            |
| ----------------------------------------- | --------------------------------------------- |
| Global read‑latency for semantic search   | **Vectorize** (globally replicated vector DB) |
| Serverless API & background jobs          | **Workers** & **Schedules**                   |
| Structured tables (tasks, reminders)      | **D1** (SQLite‑compatible DB)                 |
| Cheap object storage for raw docs         | **R2** buckets                                |
| Push & email notifications                | **Queues**  +  **Workers**                    |
| Run embedding / LLM locally when possible | **Workers AI**                                |
| External LLM usage & observability        | **AI Gateway**                                |
| Session or per‑user state                 | **Durable Objects**                           |

---

## 1 . Service taxonomy

```
 ┌────────────────────────────────────────────────┐
 │  User (CLI/TUI, browser extension, Slack bot) │
 └────────────────────────────────────────────────┘
                │ HTTPS
                ▼
 ┌────────────────────────────────────────────────┐
 │  • API Worker (dome-api)                      │
 │    - REST/JSON endpoints                      │
 │    - GraphQL playground (optional)            │
 │    - Talks to: D1, Vectorize, R2, Queues      │
 └────────────────────────────────────────────────┘
                │
 ┌────────────────────────────────────────────────┐
 │  • Vectorize index (“dome-notes”)             │
 └────────────────────────────────────────────────┘
 ┌────────────────────────────────────────────────┐
 │  • D1 database (“dome-meta”)                  │
 │    - tables: notes, tasks, reminders, tags    │
 └────────────────────────────────────────────────┘
 ┌────────────────────────────────────────────────┐
 │  • R2 bucket (“dome-raw”)                     │
 │    - PDFs, images, audio blobs                │
 └────────────────────────────────────────────────┘
 ┌────────────────────────────────────────────────┐
 │  • Queue (“dome-events”)                      │
 │    - reminder_due, ingestion_complete, ...    │
 └────────────────────────────────────────────────┘
                │ pushed events
 ┌────────────────────────────────────────────────┐
 │  • Notification Worker (dome‑notify)          │
 │    - consumes Queue                           │
 │    - emails / Slack / Web‑push                │
 └────────────────────────────────────────────────┘
                ▲ cron
 ┌────────────────────────────────────────────────┐
 │  • Scheduler Worker (dome‑cron)               │
 │    - Cron at :00 every min (or 5 min)         │
 │    - scans D1 for due reminders, pushes event │
 └────────────────────────────────────────────────┘
```

---

## 2 . Cloudflare resources

| Resource                            | Purpose                                    | Wrangler `resources:` binding                                      |
| ----------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| **Vectorize** index `dome_notes`    | stores embeddings (1536 dims)              | `VECTORIZE = "dome_notes"`                                         |
| **D1** DB `dome_meta`               | structured tables                          | `D1_DATABASE = "dome_meta"`                                        |
| **R2** bucket `dome_raw`            | raw file bodies                            | `R2_BUCKET = { binding = "RAW", bucket_name = "dome_raw" }`        |
| **Queue** `dome_events`             | async fan‑out                              | `QUEUE = { binding="EVENTS", queue="dome_events" }`                |
| **Durable Object** `SessionManager` | optional per‑user memory                   | `[[durable_objects.bindings]]`                                     |
| **Workers AI**                      | open‑ai‑style embeddings & local LLM       | automatic                                                          |
| **AI Gateway**                      | outgoing OpenAI key wrapped ‑ reduces cost | automatic when you prepend `https://ai.cloudflare.com/gateway/...` |

---

## 3 . Data model

### 3.1 . D1 schema (SQL)

```sql
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  context TEXT,
  body TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  description TEXT,
  due_at TIMESTAMP,
  status TEXT DEFAULT 'pending'
);

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  remind_at TIMESTAMP,
  delivered BOOLEAN DEFAULT 0
);
```

### 3.2 . Vectorize schema

```toml
name   = "dome_notes"
dims   = 1536
metric = "cosine"
metadata_schema = { user_id="string", note_id="string", created_at="string" }
```

Vectorize only stores the embedding + metadata; the full note text lives in D1 (or R2 if huge).

---

## 4 . Workers

### 4.1 API Worker (`src/worker/api.ts`)

_Responsibilities_

| Endpoint                        | Flow                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **POST /ingest** (file or text) | 1) Create note row in D1<br>2) If file ⇒ `RAW.put` object<br>3) Generate embedding (Workers AI or OpenAI via AI Gateway)<br>4) `VECTORIZE.put()` |
| **GET /search?q=…**             | 1) embed query; 2) `VECTORIZE.query()` top K; 3) fetch note bodies from D1; 4) stream back JSON                                                  |
| **POST /tasks**                 | insert task & optional reminder rows                                                                                                             |
| **GET /tasks?status=pending**   | SQL SELECT                                                                                                                                       |
| **POST /tasks/:id/complete**    | UPDATE task SET status='done'                                                                                                                    |
| **POST /chat** (RAG)            | 1) embed query; 2) fetch context chunks; 3) call LLM (Workers AI or OpenAI) with RAG prompt; 4) return answer                                    |

*Tech stack* — TypeScript Worker using Hono router; Zod for validation; Drizzle for D1 access.

### 4.2 Scheduler Worker (`src/worker/scheduler.ts`)

```ts
export default {
  async scheduled(event, env, ctx) {
    const due = await env.D1_DATABASE.prepare(
      `
      SELECT t.id, t.description, r.id AS rid, r.remind_at
      FROM tasks t
      JOIN reminders r ON r.task_id = t.id
      WHERE r.delivered = 0 AND r.remind_at <= datetime('now')
    `,
    ).all();
    for (const row of due.results) {
      await env.EVENTS.send({
        kind: 'reminder_due',
        taskId: row.id,
        description: row.description,
        reminderId: row.rid,
      });
    }
  },
};
```

Cron in `wrangler.toml`:

```toml
[triggers]
crons = ["*/5 * * * *"]   # every 5 min
```

### 4.3 Notification Worker (`src/worker/notify.ts`)

Consumes `dome_events`.
On `"reminder_due"`: send email via MailChannels or Slack via webhook, then mark `reminders.delivered = 1`.

---

## 5 . Ingest & search flow

```text
User CLI  ───►  API Worker /ingest
            ①  POST body / file
            ②  store raw in R2     (if >32 kB)
            ③  store metadata in D1
            ④  Workers AI ‑embed(text)
            ⑤  Vectorize.put(embed, meta)

Query ►  /search?q=...
  ① embed query
  ② Vectorize.query → ids
  ③ SELECT bodies
  ④ stream JSON

Chat ►  /chat
  same as search but feed context into LLM
```

Latency: Workers AI embedding ≈10 ms avg, Vectorize query ≈2‑3 ms P99 citeturn0search1.

---

## 6 . Wrangler config (excerpt)

```toml
name = "dome-api"
main = "src/worker/api.ts"
compatibility_date = "2025-04-17"

[[vectorize]]
binding = "VECTORIZE"
index_name = "dome_notes"

[[d1_databases]]
binding = "D1_DATABASE"
database_name = "dome_meta"

[[r2_buckets]]
binding = "RAW"
bucket_name = "dome_raw"

[[queues.producers]]
binding = "EVENTS"
queue_name = "dome_events"

[[ai]]
binding = "AI"              # Workers AI

[triggers]
crons = []  # not for api worker
```

Scheduler & notify workers have their own `wrangler.toml`, each binding only what they need.

---

## 7 . CI/CD

1. **GitHub Actions**
   - `wrangler deploy` on `main` for _api_, _scheduler_, _notify_.
   - `wrangler d1 migrations apply` when schema changes.
2. **API preview** (`wrangler dev`) for local dev; in‑memory Vectorize compatible stub.
3. **Smoke tests** using Miniflare + dummy bindings.

---

## 8 . Cost model (April 2025 pricing)

| Component                       | Free tier                    | Paid tier notes                            |
| ------------------------------- | ---------------------------- | ------------------------------------------ |
| Workers (3 per account free)    | 100 k req/day                | $0.30 per M thereafter                     |
| Vectorize                       | 100 k ops/day                | $1 per million queries citeturn0search4 |
| Workers AI                      | 10 k inferences/day          | $0.50 per 1 k embeddings                   |
| D1                              | 25 MB & 100 k requests/month | pay‑as‑you‑go after                        |
| R2                              | 10 GB free                   | $0.015 / GB‑month                          |
| Queues                          | 100 k msgs/day               | $0.40 per M msgs                           |
| AI Gateway (OpenAI passthrough) | Free                         | 0.25 ¢ per model call (includes caching)   |

For a side‑project scale (<10 k users) the bill is typically < $20/month.

---

## 9 . Migration steps from Docker + FAISS

| Step | Action                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Replace FAISS calls with Vectorize SDK (`@cloudflare/workers-types`)                                                                                 |
| 2    | Move SQLAlchemy models to **D1 SQL**; generate `schema.sql` and ship in repo                                                                         |
| 3    | Convert FastAPI routes → Hono (or itty‑router) handlers                                                                                              |
| 4    | Replace Celery/apscheduler with Cloudflare Cron + Queues                                                                                             |
| 5    | Store large binary uploads in R2 instead of local disk                                                                                               |
| 6    | Write Wrangler config, add secrets (`OPENAI_API_KEY`, etc.)                                                                                          |
| 7    | `wrangler d1 create dome_meta && wrangler vectorize create dome_notes`                                                                               |
| 8    | Deploy and backfill: iterate over existing Postgres rows, ingest into Vectorize via Workers KV bulk script (can run locally with `wrangler workerd`) |

---

## 10 . Open items & trade‑offs

| Concern                                   | Mitigation                                                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Worker CPU limits (10 ms/req)             | heavy PDF parsing offloaded to an **“ingestor” queue** worker with `Service-Binding` to vectorize; or pre‑parse client‑side |
| File size limit (10 MB per request)       | upload big files directly to R2 with a signed URL                                                                           |
| Long‑running tasks (embedding many pages) | chunk + push per‑page events to Queues; back‑pressure handled automatically                                                 |
| Multi‑user tenancy                        | partition D1 tables by `user_id`, add `namespace` metadata field in Vectorize                                               |

---

## 11 . Reference snippets

### 11.1 . Vectorize query inside Worker

```ts
import { Ai } from '@cloudflare/ai';

export async function semanticSearch(env, query: string) {
  const ai = new Ai(env.AI);
  const embedding = await ai.run('@cf/baai/bge-small-en-v1.5', { text: query });

  const results = await env.VECTORIZE.query(embedding, { topK: 10, filter: { user_id: ['123'] } });
  return results.matches.map(m => ({
    noteId: m.metadata.note_id,
    score: m.score,
  }));
}
```

### 11.2 . Queue producer

```ts
await env.EVENTS.send({
  kind: 'reminder_due',
  userId,
  taskId,
  message: `Don't forget: ${task.description}`,
});
```

### 11.3 . Queue consumer

```ts
export default {
  async queue(batch, env) {
    for (const msg of batch.messages) {
      if (msg.body.kind === 'reminder_due') {
        await sendSlackDM(msg.body.userId, msg.body.message);
        await env.D1_DATABASE.prepare('UPDATE reminders SET delivered=1 WHERE id=?')
          .bind(msg.body.reminderId)
          .run();
      }
    }
  },
};
```

---

## 12 . Benefits

- **Global latency**: search & chat answers <50 ms from anywhere.
- **Operational zero‑ops**: no server patching, no k8s cluster.
- **Elastic cost**: pay only for traffic & embeddings actually consumed.
- **Unified observability**: Cloudflare Logs, Vectorize metrics, AI Gateway cost dashboard.

---

### Ready to kick off?

1. `npm create cloudflare@latest` → select _Workers+AI+Vectorize_ template.
2. Copy your ingestion & search logic into the generated `src/index.ts`.
3. `wrangler dev --remote` to hit live Vectorize from localhost.
4. Iterate, commit, `wrangler deploy`.

With this design, _DOME_ becomes a fully serverless, globally distributed knowledge base that can grow from one user to millions with no architectural changes.
