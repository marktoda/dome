---
type: spec
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]", "[[v1]]"]
---

# Projection store

This spec is normative for Dome's derived-state layer. The **projection store** is a Bun.sqlite-backed cache of facts, search indexes, diagnostics, questions, scheduled jobs, and an outbox for external side effects. It is the answer to "where do view-phase processors read from."

The store is **derived**. Markdown + git history is the source of truth ([[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]); the projection store can be deleted and rebuilt at any time. This is pinned by [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]].

## Why SQLite (and why Bun.sqlite)

Three properties drive the choice:

1. **Single-file, atomic, transactional.** A SQLite file at `<vault>/.dome/state/projection.db` survives crashes; transactions guarantee a write either commits or doesn't; no separate process. The operational footprint matches markdown-on-disk.
2. **FTS5 for free.** SQLite's FTS5 extension provides full-text search with ranking, snippet generation, and prefix queries — the search surface Dome needs without adding a separate index engine.
3. **Bun.sqlite is in-runtime.** Bun ships SQLite as a built-in module (`bun:sqlite`). No native-module-rebuild, no separate package, no compile step. The dependency reduces from "another binary" to "another import."

## File layout

```
<vault>/.dome/state/
  projection.db       # this spec — facts, fts, diagnostics, questions, scheduled_jobs, schedule_cursors
  runs.db             # see [[wiki/specs/run-ledger]]
  outbox.db           # see §"Outbox" below
  quarantined.json    # processor-quarantine state (carried forward from v0.5)
  last-reconcile-mtime.txt  # see [[wiki/specs/adoption]] §"Migration"
```

The three `.db` files are independent SQLite databases. Splitting by concern (projections / runs / outbox) keeps the schemas focused and the rebuild paths independent — wiping `projection.db` to recover from schema skew doesn't touch the run ledger's audit history.

All three files are gitignored ([[wiki/specs/vault-layout]] §"Derived operational state"). They never appear in a Proposal.

## Cache key

Every row in `projection.db` is keyed (in addition to its table-specific primary key) by:

```
(adoptedCommit, extensionSetHash, processorVersionsHash)
```

- `adoptedCommit` — the SHA of `refs/dome/adopted/<branch>` when the row was written.
- `extensionSetHash` — sha256 of the sorted list of installed bundle names + versions. Adding or removing a bundle invalidates everything.
- `processorVersionsHash` — sha256 of the sorted list of `(processorId, version)` for every loaded processor. Bumping a processor version invalidates its rows.

When any of the three change, the engine considers cached rows stale and re-derives them. The cache key triple is stored in a `projection_meta` table:

```sql
CREATE TABLE projection_meta (
  adopted_commit          TEXT NOT NULL,
  extension_set_hash      TEXT NOT NULL,
  processor_versions_hash TEXT NOT NULL,
  built_at                TEXT NOT NULL,  -- ISO-8601
  PRIMARY KEY (adopted_commit, extension_set_hash, processor_versions_hash)
);
```

This is the structural fence behind [[wiki/gotchas/processor-version-drift]] and [[wiki/gotchas/projection-schema-skew]].

## Tables

### `facts`

Stores `FactEffect` rows.

```sql
CREATE TABLE facts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace       TEXT NOT NULL,        -- e.g., "dome.tasks", "dome.people"
  subject_kind    TEXT NOT NULL,        -- "page" | "task" | "entity"
  subject_id      TEXT NOT NULL,        -- path | stableId | entity name
  predicate       TEXT NOT NULL,        -- e.g., "dueDate", "attendee"
  object_json     TEXT NOT NULL,        -- JSON-encoded NodeRef | Literal
  assertion       TEXT NOT NULL,        -- "explicit" | "extracted" | "inferred" | "generated"
  confidence      REAL,                 -- nullable; required for inferred/generated
  source_refs     TEXT NOT NULL,        -- JSON-encoded SourceRef[]
  processor_id    TEXT NOT NULL,
  adopted_commit  TEXT NOT NULL,
  written_at      TEXT NOT NULL
);
CREATE INDEX facts_by_subject ON facts(subject_kind, subject_id);
CREATE INDEX facts_by_namespace ON facts(namespace);
CREATE INDEX facts_by_predicate ON facts(namespace, predicate);
```

Writes scoped by `graph.write` capability per [[wiki/specs/capabilities]] §"graph.write".

### `fts_documents` (FTS5)

Full-text search over markdown bodies, maintained by `dome.search`'s `index-text` adoption-phase processor.

```sql
CREATE VIRTUAL TABLE fts_documents USING fts5(
  path UNINDEXED,
  category UNINDEXED,
  type UNINDEXED,
  title,
  body,
  adopted_commit UNINDEXED,
  tokenize = 'porter unicode61'
);
```

Updated incrementally on `document.changed` signals during adoption.

### `diagnostics`

Stores `DiagnosticEffect` rows.

```sql
CREATE TABLE diagnostics (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  severity          TEXT NOT NULL,        -- "info" | "warning" | "error" | "block"
  code              TEXT NOT NULL,        -- e.g., "wikilink.unresolved"
  message           TEXT NOT NULL,
  source_refs       TEXT NOT NULL,        -- JSON-encoded SourceRef[]
  source_refs_hash  TEXT NOT NULL,        -- sha256-hex of source_refs JSON; dedup discriminator
  processor_id      TEXT NOT NULL,
  proposal_id       TEXT,                 -- nullable; null for diagnostics not tied to a proposal
  adopted_commit    TEXT NOT NULL,
  written_at        TEXT NOT NULL,
  resolved_at       TEXT,                 -- nullable; set when the diagnostic no longer applies
  UNIQUE (processor_id, code, proposal_id, source_refs_hash)
);
```

The `UNIQUE` constraint dedups when a processor re-emits the same diagnostic at the same source location across retries — but does NOT collapse multiple distinct diagnostics from one processor invocation (e.g., `validate-wikilinks` finding many broken links across many files all get their own rows because their `sourceRefs` differ). Prior to the `source_refs_hash` discriminator, the constraint was `UNIQUE (processor_id, code, proposal_id)` which silently merged all distinct diagnostics from one processor in one proposal into a single row.

### `questions`

Stores `QuestionEffect` rows.

```sql
CREATE TABLE questions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  question        TEXT NOT NULL,
  options_json    TEXT,                 -- JSON-encoded string[] | null
  source_refs     TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  processor_id    TEXT NOT NULL,
  adopted_commit  TEXT NOT NULL,
  asked_at        TEXT NOT NULL,
  answered_at     TEXT,                 -- nullable
  answer          TEXT                  -- nullable; user's response
);
```

### `scheduled_jobs`

Stores `JobEffect` rows for jobs that run later (when `runAfter` is set).

```sql
CREATE TABLE scheduled_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  processor_id    TEXT NOT NULL,
  input_json      TEXT NOT NULL,
  run_after       TEXT NOT NULL,        -- ISO-8601
  idempotency_key TEXT NOT NULL UNIQUE,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  attempts        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,        -- "pending" | "running" | "succeeded" | "failed"
  enqueued_at     TEXT NOT NULL,
  completed_at    TEXT
);
```

### `schedule_cursors`

Tracks last-fire times for cron-driven processors. Replaces v0.5's `<vault>/.dome/state/scheduled.json` JSON file.

```sql
CREATE TABLE schedule_cursors (
  processor_id    TEXT NOT NULL PRIMARY KEY,
  cron            TEXT NOT NULL,
  last_fire       TEXT NOT NULL,        -- ISO-8601
  next_fire       TEXT NOT NULL         -- ISO-8601; computed from cron + last_fire
);
```

The at-most-once-per-sync clamp for missed intervals ([[wiki/gotchas/scheduled-hook-idempotency]] — name carried forward, semantics unchanged) is enforced by the engine: it updates `last_fire` to the current time, not the missed-interval time, so multiple missed intervals collapse to one fire.

## Outbox (separate database: `outbox.db`)

External side effects are split into their own SQLite file because the failure characteristics differ — outbox rows survive across vault re-opens, projection rebuilds, and engine restarts independently of the projection cache lifecycle.

```sql
CREATE TABLE outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  capability      TEXT NOT NULL,        -- e.g., "calendar.write"
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json    TEXT NOT NULL,
  source_refs     TEXT NOT NULL,
  status          TEXT NOT NULL,        -- "pending" | "sent" | "failed" | "abandoned"
  external_id     TEXT,                 -- nullable; the remote system's id once sent
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  enqueued_at     TEXT NOT NULL,
  sent_at         TEXT,
  last_error      TEXT,                 -- nullable; most recent failure message
  run_id          TEXT NOT NULL         -- the RunRecord row that emitted this
);
CREATE INDEX outbox_by_status ON outbox(status, enqueued_at);
```

**Lifecycle:**

1. Processor emits `ExternalActionEffect`.
2. Engine inserts row with `status: "pending"`, then calls the registered capability handler.
3. On success, handler returns `externalId`; engine updates row to `status: "sent"`, `external_id: <id>`.
4. On failure (`attempts < maxAttempts`), engine schedules a retry with exponential backoff; row stays `pending`.
5. On terminal failure (`attempts >= maxAttempts`), engine marks `status: "failed"`. Recovery follows the engine-asks model: the engine emits `engine.outbox.terminal-failure`; the deferred `dome.health` bundle's question-emitter processor raises a `QuestionEffect` with options `["retry", "abandon"]`; the user answers via `dome answer <question-id>`; the answer-handler processor applies the mutation. See [[wiki/specs/cli]] §"dome answer" and [[wiki/gotchas/outbox-stuck]]. v1.0 surfaces failed rows via `dome show outbox`; the answer-handler loop ships with `dome.health` in v1.x.

This is the structural fence behind [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]] and [[wiki/gotchas/outbox-stuck]].

## Rebuild path

`dome rebuild` walks every adopted commit's tree and re-runs every adoption-phase processor that contributes to projections, then re-runs garden-phase processors that produce non-PatchEffect outputs (Facts, Diagnostics, Questions). The rebuild does NOT re-run processors that produced patches (those patches already landed in adopted commits) and does NOT re-fire external actions (the outbox is preserved).

```text
dome rebuild
  → delete projection.db
  → recreate schema
  → walk wiki/, raw/, inbox/, notes/ at the current adopted commit
    → for each file, synthesize the trigger payload and fire the relevant adoption-phase processors
    → write resulting FactEffect / DiagnosticEffect to facts / diagnostics
    → write fts_documents rows
  → re-run garden-phase processors that emit Facts (e.g., dome.intake.extract-capture)
  → emit `engine.projection.rebuilt` event
```

The rebuild is **idempotent** — running it twice in succession produces byte-equivalent `.db` files (modulo `written_at` timestamps).

Wall-clock cost scales with vault size + processor count. For a typical user vault (hundreds to low thousands of pages, a dozen processors), rebuild is seconds. For a 50k-page vault, rebuild is a couple of minutes. The user-facing UX is "you can always wipe and rebuild" — slow but correct.

## Schema migrations

Schema migrations are **the rebuild**. The projection store does not carry a schema-migration system; when the schema changes (Dome SDK version bump introducing a new column or table), the engine detects schema-version mismatch on `openVault` and triggers `dome rebuild` automatically, surfacing a one-line message:

```text
dome: projection schema changed (v3 → v4); rebuilding (~30s for this vault)...
```

The schema version is the sha256 of the concatenated `CREATE TABLE` / `CREATE INDEX` / `CREATE VIRTUAL TABLE` statements. A version row in `projection_meta` stores it. Mismatch → wipe + rebuild.

This is what [[wiki/gotchas/projection-schema-skew]] documents — and the automatic rebuild is the mitigation. The user never edits schemas; they just see a "rebuilding..." message after a SDK upgrade.

## Query API (the view-phase reading surface)

View-phase processors read from the projection store via the query API exposed in `ProcessorContext`:

```ts
interface ProjectionQuery {
  searchDocuments(input: { query: string; filters?: SearchFilters }): Promise<SearchMatch[]>;
  factsBySubject(subject: NodeRef): Promise<FactEffect[]>;
  factsByPredicate(namespace: string, predicate: string): Promise<FactEffect[]>;
  diagnostics(filter?: { severity?: DiagnosticSeverity; processorId?: string }): Promise<DiagnosticEffect[]>;
  questions(filter?: { resolved?: boolean }): Promise<QuestionEffect[]>;
}
```

The query API is read-only. View-phase processors don't write to the projection store directly — they emit ViewEffect with the assembled response; the engine returns it to the caller.

## What the projection store cannot do

- **Become the source of truth.** Anything that lives only in the projection store is by definition not durable. Markdown + git history is durable; the projection store is a cache. If a projection table holds data that *can't* be derived from markdown + processor invocations, it doesn't belong here.
- **Cross-vault state.** One projection.db per vault. No global cache, no cross-vault facts.
- **Be queried by non-engine code.** Plugin processors reach the store via `ProcessorContext.projection`; external code (CLI, MCP, future HTTP) reaches it via the engine's query API, never via direct SQLite handles.

## Related

- [[wiki/specs/effects]] §"FactEffect" / "DiagnosticEffect" / "QuestionEffect" / "JobEffect" / "ExternalActionEffect" — what writes to the store
- [[wiki/specs/processors]] — view-phase reading
- [[wiki/specs/run-ledger]] — adjacent SQLite file for processor-run history
- [[wiki/specs/capabilities]] — graph.write namespace scoping
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — the store is always rebuildable
- [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] — the structural fence
- [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]] — outbox enforcement
- [[wiki/gotchas/projection-schema-skew]] — automatic rebuild on version mismatch
- [[wiki/gotchas/outbox-stuck]] — terminal-failure recovery
- [[wiki/gotchas/processor-version-drift]] — cache invalidation on version bump
- [[wiki/matrices/projection-table-x-owner]] — which extension owns which table
