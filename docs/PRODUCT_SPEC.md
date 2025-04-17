## 1. Overview (Dome)

An AI‑powered personal memory assistant that:

- Accepts **natural‑language** inputs (notes, todos, reminders, files, links)
- Persists everything in Cloudflare’s **serverless data plane**
  - **D1** for structured rows
  - **Vectorize** for embeddings
  - **R2** for large blobs
- Retrieves information with **semantic search** + RAG in < 50 ms worldwide
- Exposes a **Workers‑based API** (REST + optional GraphQL)
- Offers a **terminal TUI** (`/add`, `/note`, `/list`, `/show`, `/chat`, …) and pluggable clients (Slack bot, browser extension)
- Sends reminders via **Queues → Notification Worker** (email, Slack, push)
- Runs completely server‑less—no VMs, no Kubernetes—scaling to millions of users on demand.

---

## 2. Natural‑Language Input

Same as before, but routed to the Cloudflare **API Worker**:

```
POST /ingest         # /add in the TUI
POST /note/:context  # start or append to session
GET  /search?q=...
POST /chat
```

The API Worker:

1. **Classifies** the text (note, todo, reminder, file URL) with Workers AI or rule‑based patterns.
2. **Extracts** entities (dates, tags, names) via an LLM prompt.
3. **Stores**:
   - row in **D1** (`notes`, `tasks`, `reminders`)
   - embedding in **Vectorize**
   - raw file in **R2** (when applicable)

---

## 3. NLP & Intent Extraction (Workers AI)

```ts
const result = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
  prompt: `
  Classify and extract JSON:
  Text: "${input}"
  Return: {"intent": "...", "datetime": "...", "context": "..."}
  `,
});
```

The JSON output feeds straight into the D1 insert + reminder scheduler.

---

## 4. Storage & Knowledge Base

| Layer          | Tech                                                    | What it holds                                           |
| -------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| **Vector**     | **Cloudflare Vectorize** index `dome_notes` (1536 dims) | Embeddings + metadata (`note_id`, `user_id`, timestamp) |
| **Structured** | **D1** SQLite DB `dome_meta`                            | Tables: `notes`, `tasks`, `reminders`, `tags`           |
| **Objects**    | **R2** bucket `dome_raw`                                | PDFs, images, audio, >32 kB text blobs                  |

All three are globally replicated; the API Worker calls them via bindings, so latency is Edge‑local.

---

## 5. Vector Database (Vectorize)

- **Write**: `VECTORIZE.put(embedding, {metadata})` during ingest.
- **Query**: `VECTORIZE.query(embedding, {topK:10, filter:{user_id}})` in `/search` & `/chat`.
- P99 latency ≈ 2 ms, capacity 100 k ops/day free.
- No self‑hosting; replication & durability managed by Cloudflare.

---

## 6. Retrieval‑Augmented Generation

1. Embed query (Workers AI model `@cf/baai/bge-small-en-v1.5`).
2. Fetch top K matches from Vectorize.
3. Pull note bodies from D1.
4. Assemble context + user query into an LLM prompt (`@cf/meta/llama‑3‑8b` or OpenAI via AI Gateway).
5. Stream answer back to the client.

---

## 7. Scheduling & Notifications

| Component                                 | Role                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Scheduler Worker** (`cron` every 5 min) | SELECT due reminders from D1 → push message to **Queue**                                         |
| **Queue** (`dome_events`)                 | Durable fan‑out of `reminder_due` events                                                         |
| **Notification Worker**                   | Consumes queue, sends email (MailChannels) or Slack DM, then `UPDATE reminders SET delivered=1`. |

---

## 8. External Integrations

- **Slack** (webhooks) and **MailChannels** for outbound notifications.
- **Google Calendar** (optional) via OAuth 2: API Worker writes events on `/tasks` creation.
- Additional connectors (GitHub, Notion) can be added as separate Workers or Durable Objects.

---

## 9. TUI Command Set (unchanged)

```
/add <file|URL|text>
/note <context>
/end
/list [filter]
/show <id>
/delete <id>
/complete <id>
/remind <id> <when>
/search <keywords>
/chat <query>
/help
/exit
```

The TUI simply HTTP‑calls the Workers endpoints.

---

## 10. Cloudflare Architecture

```
┌─────────────┐   HTTPS   ┌───────────────────────────┐
│  CLI / Web  │──────────►│   dome‑api  (Worker)      │
└─────────────┘           ├────────┬──────────┬───────┤
                          │        │          │
       Vector search ─────┘        │          │  raw file → R2
             (Vectorize)           │          │
                                   │          │
                            D1 (SQL rows)     │
                                   │          │ Queue event
                                   ▼          ▼
                             dome‑cron   dome‑notify
                              (Cron)      (Consumer)
```

_All resources are declared in `wrangler.toml` bindings; a single `wrangler deploy` publishes globally._

---

## 11. Deployment & CI/CD

1. `wrangler d1 create dome_meta`
2. `wrangler vectorize create dome_notes --dims 1536 --metric cosine`
3. `wrangler deploy` for each worker (`api`, `cron`, `notify`).
4. GitHub Actions runs lint, Miniflare tests, then deploys on `main`.

---

## 12. Benefits vs. Self‑hosted FAISS

| Aspect      | FAISS‑on‑Docker           | Cloudflare Platform                |
| ----------- | ------------------------- | ---------------------------------- |
| Scaling     | manual autoscaling        | automatic, global                  |
| Ops         | maintain DB, GPU, backups | zero‑ops                           |
| Latency     | depends on region         | <50 ms worldwide                   |
| Cost        | fixed VM / GPU costs      | pay‑as‑you‑go (free tier generous) |
| Reliability | handle fail‑overs         | 6× replicated by CF                |

---

### Summary

The product now leverages **Cloudflare Workers, Vectorize, D1, R2, Queues, and Workers AI** to deliver a fully serverless, globally low‑latency personal memory assistant—no containers or databases to run, and instant scaling as your user base grows.
