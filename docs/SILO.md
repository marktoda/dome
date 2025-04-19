# **Silo — Content‑Storage Worker**

_A unified service for ingesting, cataloguing and serving user‑generated & public content._

Notes

- this is a highly experimental service, DO NOT WORRY about backwards compatibility. optimize for clean, readable, simple code that can be extended easily in the future. feel free to delete anything that is unused or unnecessary during the implementation of this change

---

## 1. Goals & Non‑Goals

|                                                                                                                                  | ✅ In Scope | ❌ Out of Scope                                       |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------- |
| **Persist content** bodies (≤ 100 MiB) in **R2** and metadata in **D1**                                                          | ✔           |                                                       |
| **Multiple content kinds** &nbsp;(`note`, `code`, `article`, …)                                                                  | ✔           | Fine‑grained ACL (handled by Dome‑Auth)               |
| **Upload paths** <br>• small sync API (`simplePut`) <br>• signed direct‑to‑R2 POST (browser) <br>• async bulk via `INGEST_QUEUE` | ✔           | Client‑side resumable multipart UI                    |
| **Event‑driven updates** → Constellation (embeddings)                                                                            | ✔           | Legacy `EMBED_QUEUE`                                  |
| **Fast batch reads** for RAG (`/batchGet`)                                                                                       | ✔           | Complex full‑text search (delegated to Constellation) |

---

## 2. High‑Level Architecture

```mermaid
graph TD
 subgraph Client
  A1[User / Browser] -- small note -->|simplePut| G(Dome‑API)
  A2 -- big file -->|pre‑signed form<br>PUT /r2| R2[(Bucket)]
 end

 subgraph Gateway
  G -- auth+rate‑limit --> SiloHTTP[/Silo · RPC bridge/]
 end

 subgraph Silo
  SiloHTTP -- write D1 · sign form --> D1[(SQLite)] & R2
  R2 -- object-create --> OCQ[CONTENT_EVENTS queue]
  OCQ -- worker.consume --> OCW(ObjectCreated handler)
  OCW -->|INSERT| D1
  OCW -->|send| FanOutQ[NEW_CONTENT queue]
 end

 subgraph Constellation
  FanOutQ --> Embeder
  D1 <--> Embeder
 end

 classDef res fill:#f5f5f5,stroke:#bbb;
 class A1,A2,G,SiloHTTP,OCW,Embeder res
```

- **R2 → Queue notifications** guarantee Silo sees every upload exactly once.
- **Fan‑out queue** decouples Silo from downstream consumers (Constellation, future analytics).
- Dome‑API remains the single public hostname; it proxies RPC to Silo’s internal worker.

---

## 3. Data Model (D1)

```sql
CREATE TABLE contents (
  id          TEXT PRIMARY KEY,      -- ulid / uuid
  userId      TEXT,                  -- NULL for public objects
  contentType TEXT NOT NULL,         -- 'note'|'code'|'article'…
  size        INTEGER NOT NULL,
  r2Key       TEXT NOT NULL UNIQUE,
  sha256      TEXT,                  -- optional integrity / de‑dup
  createdAt   INTEGER NOT NULL,      -- epoch s
  version     INTEGER DEFAULT 1
);
CREATE INDEX idx_contents_userId        ON contents(userId);
CREATE INDEX idx_contents_contentType   ON contents(contentType);
CREATE INDEX idx_contents_createdAt     ON contents(createdAt);
```

- `userId IS NULL` ⇒ object is readable by **any authenticated** user.

---

## 4. Worker Bindings

```toml
[[kv_namespaces]]   binding="CACHE" id="…"                # optional LRU
[[r2_buckets]]      binding="BUCKET" bucket_name="silo-content"
[[d1_databases]]    binding="DB"     database_name="silo"
[[queues.producers]] binding="NEW_CONTENT" queue="new-content"
[[queues.consumers]] binding="CONTENT_EVENTS" queue="content-events"
vars = { LOG_LEVEL="info", VERSION="1.0.0", ENVIRONMENT="prod" }
```

---

## 5. Upload Paths

| Path                    | Who calls       | Flow                                                                                                                                                                                                                                                                                         |
| ----------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`simplePut` RPC**     | Dome‑API → Silo | 1. Auth<br>2. `DB INSERT` (optimistic)<br>3. `R2.put(key, body)` (≤ 1 MiB)<br>4. Success 200                                                                                                                                                                                                 |
| **Signed form (large)** | Browser         | 1. Client `POST /createUpload` → Dome‑API → Silo HTTP<br>2. Silo returns S3 policy + headers containing:<br>&nbsp;&nbsp;`x-user-id`, `x-content-type`, `x-sha256`, `key=upload/{contentId}`<br>3. Browser uploads directly to R2.<br>4. R2 emits **object-create** → `CONTENT_EVENTS` queue. |
| **Bulk ingest**         | INGEST_WORKER   | Publishes `IngestTask` to `INGEST_QUEUE` (existing pattern)<br>Silo provides helper RPC `bulkPutMeta` to pre‑register rows (optional speed‑up).                                                                                                                                              |

---

## 6. Object‑Created Queue Consumer

```ts
export async function queue(batch: MessageBatch<R2Event>, env: Env) {
  for (const m of batch.messages) {
    const {
      object: { key, size },
      eventTime,
    } = m.body;
    const [, contentId] = key.split('/');
    const obj = await env.BUCKET.head(key);
    const headers = obj.httpMetadata?.headers ?? new Headers();
    await env.DB.prepare(
      `insert or ignore into contents
        (id,userId,contentType,size,r2Key,createdAt,sha256)
        values (?,?,?,?,?,?,?)`,
    )
      .bind(
        contentId,
        headers.get('x-user-id'),
        headers.get('x-content-type') ?? 'note',
        size,
        key,
        Date.parse(eventTime) / 1000,
        headers.get('x-sha256'),
      )
      .run();
    await env.NEW_CONTENT.send({ id: contentId });
  }
}
```

- **Idempotent** via `INSERT OR IGNORE`.
- If DB row existed (e.g. `simplePut`) the `object-create` event is still harmless.

---

## 7. Public RPC Surface (called internally by Dome‑API)

| RPC                                        | Arguments             | Behaviour                                                                      |
| ------------------------------------------ | --------------------- | ------------------------------------------------------------------------------ |
| `simplePut(note: {id?,contentType?,body})` | Auth header           | • Generate `id` if absent.<br>• Write R2 & DB synchronously.<br>• Return `id`. |
| `createUpload(meta)`                       | `{contentType, size}` | • Return pre‑signed policy & headers.                                          |
| `batchGet(ids[])`                          | Auth                  | • Fetch metadata rows (ACL) + `BUCKET.get()` via parallel streaming.           |
| `delete(id)`                               | Auth owner            | • Delete R2; row; emit `DeleteContent`.                                        |
| `stats()`                                  | –                     | • Return R2 used bytes + DB counts.                                            |

_All RPCs use **hono‑rpc** over service‑bindings; Dome‑API merely forwards after auth._

---

## 8. Security & ACL

- Every request to Silo binding is **internal**; Dome‑API enforces `Bearer <jwt>` and passes `x-user-id` header.
- Queue consumers are privileged internal paths.
- `userId NULL` rows are **readable to any authed user**, but **write/delete** always require ownership.

---

## 9. Observability

| Metric                     | Type    | Emitted from               |
| -------------------------- | ------- | -------------------------- |
| `silo.upload.bytes`        | counter | simplePut / object handler |
| `silo.db.write.latency_ms` | timing  | simplePut / handler        |
| `silo.queue.batch_size`    | gauge   | queue consumer             |
| `silo.queue.errors`        | counter | queue consumer catch       |
| `silo.r2.get.latency_ms`   | timing  | batchGet                   |

- **Pino** logger with flat JSON lines → Logpush; `service=silo` tag.

---

## 10. Roll‑out Plan

1. **Create** `silo-content` bucket and `silo` D1.
2. **Add** R2 notification rule → `content-events` queue.
3. **Deploy** Silo worker (feature‑flag).
4. Update **Dome‑API** to route upload endpoints to Silo RPC.
5. Migrate existing `note` upload path; verify Constellation still receives `NEW_CONTENT`.
6. Enable **browser direct** large upload UI.
7. Remove legacy `EMBED_QUEUE` after successful bake period.

---

## 11. Open Questions / Future Work

- **De‑duplication** by `sha256` (global cache of open‑source code).
- **Versioning**: increment `version` on overwrite; maybe use R2 object‑versioning.
- **Lifecycle rules**: auto‑delete stale R2 objects flagged by retention policy.

---

_Silo_ cleanly separates **storage** from **semantics**, unlocks high‑throughput ingestion and minimises latency for everyday note‑taking—all while keeping the external surface (area) small and secure.
