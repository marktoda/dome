---
type: spec
created: 2026-05-27
updated: 2026-06-02
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
  - "[[v1]]"
---

# Projection store

This spec is normative for Dome's derived-state layer. The **projection store** is a Bun.sqlite-backed cache of facts, search indexes, diagnostics, questions, scheduled jobs, and schedule cursors. The adjacent outbox database is operational retry/audit state for external side effects. Together they answer "where do view-phase processors read from" and "how does the engine recover operational work."

The projection store is **derived** for adopted-state knowledge rows. Markdown + git history is the knowledge source of truth ([[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]); facts, diagnostics, search rows, and rebuild-eligible questions in `projection.db` can be deleted and rebuilt at any time from adopted markdown plus deterministic processors. Projection-local operational rows (`scheduled_jobs`, `schedule_cursors`) reset during rebuild by design. The adjacent `answers.db`, `runs.db`, and `outbox.db` files are durable operational state and are not covered by the projection-rebuild guarantee. This is pinned by [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]].

## Why SQLite (and why Bun.sqlite)

Three properties drive the choice:

1. **Single-file, atomic, transactional.** A SQLite file at `<vault>/.dome/state/projection.db` survives crashes; transactions guarantee a write either commits or doesn't; no separate process. The operational footprint matches markdown-on-disk.
2. **FTS5 for free.** SQLite's FTS5 extension provides full-text search with ranking, snippet generation, and prefix queries — the search surface Dome needs without adding a separate index engine.
3. **Bun.sqlite is in-runtime.** Bun ships SQLite as a built-in module (`bun:sqlite`). No native-module-rebuild, no separate package, no compile step. The dependency reduces from "another binary" to "another import."

## File layout

```
<vault>/.dome/state/
  projection.db       # this spec — facts, fts, diagnostics, questions, scheduled_jobs, schedule_cursors
  answers.db          # durable user answers to QuestionEffect rows
  runs.db             # see [[wiki/specs/run-ledger]]
  outbox.db           # see §"Outbox" below
  quarantined.json    # processor-quarantine state with generation ids; reset via QuarantineRecoveryEffect
  last-reconcile-mtime.txt  # see [[wiki/specs/adoption]] §"Migration"
```

The four `.db` files are independent SQLite databases. Splitting by concern (projections / answers / runs / outbox) keeps the schemas focused and the rebuild paths independent — wiping `projection.db` to recover from schema skew doesn't touch human answers or the run ledger's audit history.

All four files are gitignored ([[wiki/specs/vault-layout]] §"Derived operational state"). They never appear in a Proposal.

## Cache key

Every row in `projection.db` is keyed (in addition to its table-specific primary key) by:

```
(adoptedCommit, extensionSetHash, processorVersionsHash, capabilityPolicyHash)
```

- `adoptedCommit` — the SHA of `refs/dome/adopted/<branch>` when the row was written.
- `extensionSetHash` — sha256 of the sorted list of installed bundle names + versions. Adding or removing a bundle invalidates everything.
- `processorVersionsHash` — sha256 of the sorted list of `(processorId, version)` for every loaded processor. Bumping a processor version invalidates the projection cache.
- `capabilityPolicyHash` — sha256 of the effective vault runtime policy and enabled-extension grants. Changing `.dome/config.yaml` in a way that alters processor visibility, activation, or runtime limits invalidates the projection cache.

When any of these change, the engine considers cached rows stale and re-derives them from the adopted commit before operational or view work reads projection rows. V1 uses full projection rebuild for cache-key drift; per-processor invalidation is an optimization, not the correctness boundary. Candidate-bound projection-global config files, currently `.dome/page-types.yaml`, also force a full rebuild when adopted because they can change diagnostics for pages outside the commit's changed-path set. The cache key tuple is stored in a `projection_meta` table:

```sql
CREATE TABLE projection_meta (
  schema_hash             TEXT NOT NULL,
  adopted_commit          TEXT,
  extension_set_hash      TEXT,
  processor_versions_hash TEXT,
  capability_policy_hash  TEXT,
  built_at                TEXT,  -- ISO-8601
  PRIMARY KEY (schema_hash)
);
```

The cache-key fields are nullable on first open, before the first successful
projection rebuild stamps adopted state. Once a rebuild completes, the engine
fills the cache-key columns.

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
  run_id          TEXT NOT NULL,        -- RunRecord row that produced this claim
  adopted_commit  TEXT NOT NULL,
  written_at      TEXT NOT NULL
);
CREATE INDEX facts_by_subject ON facts(subject_kind, subject_id);
CREATE INDEX facts_by_namespace ON facts(namespace);
CREATE INDEX facts_by_predicate ON facts(namespace, predicate);
```

Writes scoped by `graph.write` capability per [[wiki/specs/capabilities]]
§"graph.write". `processor_id`, `run_id`, `source_refs`, and
`adopted_commit` make generated claims explainable from `dome inspect facts`
without treating the projection store as source of truth.

Incremental adoption resolves stale page-subject facts at the same boundary as
diagnostic auto-resolve: after a processor succeeds, before its new FactEffects
are inserted, the projection sink deletes that processor's prior
`subject_kind = 'page'` rows for the paths it re-inspected. This makes
deterministic extractors like `dome.graph.links` and `dome.graph.tag-index`
replace page facts on modified/deleted files without giving processors a
direct delete API. Task and entity fact invalidation is intentionally not
automatic until those subjects have a stable lifecycle policy.

The re-inspected path set comes from the processor's manifest `inspection`
scope. The default scope is changed paths. Processors that actually walk the
whole readable markdown set may declare `all-readable-markdown`, letting
diagnostic and fact cleanup resolve stale rows anchored in unchanged files when
another file changes their interpretation.

### `fts_documents` (FTS5)

Full-text search over markdown bodies, maintained by `dome.search`'s `index-text` adoption-phase processor.

```sql
CREATE VIRTUAL TABLE fts_documents USING fts5(
  path UNINDEXED,
  category UNINDEXED,
  type UNINDEXED,
  title,
  body,
  source_refs UNINDEXED,
  adopted_commit UNINDEXED,
  tokenize = 'porter unicode61'
);
```

Updated incrementally by SearchDocumentEffect on `document.changed`,
`file.created`, and `file.deleted` signals during adoption. Upsert replaces
the row for `path`; delete removes it. `source_refs` is JSON provenance used by
`dome query` results.

### `diagnostics`

Stores `DiagnosticEffect` rows. Both processor-emitted diagnostics and engine-created diagnostics land here; engine-created rows use synthetic `processor_id` producer ids such as `engine.adoption`, `engine.scheduler`, `engine.jobs`, and `engine.garden`.

```sql
CREATE TABLE diagnostics (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  severity          TEXT NOT NULL,        -- "info" | "warning" | "error" | "block"
  code              TEXT NOT NULL,        -- e.g., "wikilink.unresolved"
  message           TEXT NOT NULL,
  source_refs       TEXT NOT NULL,        -- JSON-encoded SourceRef[]
  subject_hash      TEXT NOT NULL,        -- sha256-hex of {path,range,stableId} per ref; dedup discriminator
  processor_id      TEXT NOT NULL,
  run_id            TEXT,                 -- nullable for engine-created diagnostics without a run
  proposal_id       TEXT,                 -- nullable; null for diagnostics not tied to a proposal
  adopted_commit    TEXT NOT NULL,
  written_at        TEXT NOT NULL,
  resolved_at       TEXT,                 -- nullable; set when the diagnostic no longer applies
  UNIQUE (processor_id, code, proposal_id, subject_hash)
);
```

`processor_id`, `run_id`, `proposal_id`, `adopted_commit`, and
`source_refs` are the diagnostic provenance surface. Processor-emitted rows
carry the emitting run id. Engine-created diagnostics that are not associated
with a processor ledger row keep `run_id` null and remain inspectable as
engine-owned rows.

`subject_hash` is **content-based identity**, not provenance-based: each SourceRef projects to `{ path, range, stableId }` before hashing, dropping `commit` and `blob`. The discriminator's purpose is "is this the same finding on the same vault span?" — a question the candidate commit is independent of. Two diagnostics anchored to `wiki/foo.md` line 3 hash to the same `subject_hash` whether they were emitted against the user's commit or against a closure commit that advanced the candidate; the `UNIQUE` constraint then collapses the re-emission via `INSERT OR IGNORE`.

The `UNIQUE` constraint therefore dedups two distinct cases under one rule:
1. **Retry within one iteration** — a processor surfaces the same finding twice in one invocation (programmer bug or transient).
2. **Re-emission across loop iterations** — the adoption fixed-point loop re-runs the processor against a successor candidate after a sibling PatchEffect advanced the tree; the same finding should land once, not once per iteration.

It does NOT collapse multiple distinct diagnostics from one processor invocation: `validate-wikilinks` finding many broken links across many files gets one row per finding because their `(path, range)` differ.

Across proposals, the same still-broken source span may be emitted again with
a different `proposal_id` after the user edits the file but does not fix that
particular issue. Live diagnostic queries return only the newest unresolved
row for a `(processor_id, code, subject_hash)` identity, and stale-resolution
prunes older unresolved duplicates when the processor re-inspects the path.
Historical rows remain in the table with `resolved_at` populated so `check`
does not make a current problem look duplicated or unresponsive.

Two prior shapes have been retired:
- `UNIQUE (processor_id, code, proposal_id)` (no hash) collapsed all distinct diagnostics from one processor in one proposal into a single row, masking real defects in the user's vault.
- `UNIQUE (..., source_refs_hash)` where `source_refs_hash` hashed the full SourceRef including `commit` over-distinguished re-emissions across loop iterations: the same finding landed twice (once per candidate commit) instead of once.

The structural fence is the `tests/harness/scenarios/effect-kinds/patch-and-diagnostic-same-cycle.scenario.test.ts` scenario, which asserts exactly one row when a sibling patch causes a re-iteration.

### `questions`

Stores `QuestionEffect` rows.

```sql
CREATE TABLE questions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  question        TEXT NOT NULL,
  options_json    TEXT,                 -- JSON-encoded string[] | null
  metadata_json   TEXT,                 -- JSON-encoded QuestionMetadata | null
  source_refs     TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  processor_id    TEXT NOT NULL,
  run_id          TEXT NOT NULL,        -- RunRecord row that emitted this question
  adopted_commit  TEXT NOT NULL,
  asked_at        TEXT NOT NULL,
  answered_at     TEXT,                 -- nullable
  answer          TEXT                  -- nullable; user's response
);
```

The processor-facing QueryView exposes `ProjectionQuestion[]`: the
`QuestionEffect` fields, including optional automation metadata, plus the
durable row id and answer metadata. This lets view processors render
resolve-ready daily/planning surfaces without touching SQLite. CLI/recovery
code uses the same row-record accessor for full detail.
`dome check` prints the normal open-decision view; advanced
`dome inspect questions` prints the raw row records.
`dome resolve <id> <value>` validates the answer and sets `answered_at` /
`answer`.

`idempotency_key` is the semantic identity of the question. Re-emitting an
unanswered question with the same key refreshes its wording, metadata,
SourceRefs, processor id, run id, and adopted commit while preserving the
durable row id and original `asked_at`. Re-emitting an answered question with
the same key does not overwrite the row; answered rows remain an audit surface
for the decision that was recorded.

Design note: answer values are user input, not rebuildable markdown-derived
facts. `projection.db.questions.answer` is a denormalized view of the current
answer for inspect/query ergonomics; the durable source of truth is
`answers.db.question_answers`, keyed by `QuestionEffect.idempotencyKey`.
Projection rebuild resets and replays `QuestionEffect` rows, then reapplies
matching durable answers from `answers.db`. The same durable row carries
answer-handler dispatch state (`pending`, `handled`, `failed`, `skipped`) so a
crash after recording the answer but before completing handler dispatch can be
retried by re-running `dome resolve <id> <value>`.

Incremental adoption resolves stale derived questions after a successful
processor re-inspects a bounded path set. A prior row from the same processor
whose `source_refs` touch an inspected path is kept only if the run re-emitted
the same `idempotency_key`; otherwise it is deleted. This keeps pending
questions aligned with the currently adopted markdown when a user removes or
clarifies ambiguous prose, without giving processors a direct delete API.

### `scheduled_jobs`

Stores `JobEffect` rows for deferred garden-phase work. `runAfter` defaults
to enqueue time when absent, so immediate jobs and delayed jobs share the same
durable queue. The engine atomically claims one due `pending` row by moving it
to `running` and incrementing `attempts` before invoking target processor code.
Retryable target-processor failures return the row to `pending` with bounded
backoff until `max_attempts` is exhausted; non-retryable failures move directly
to `failed`.

```sql
CREATE TABLE scheduled_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  processor_id    TEXT NOT NULL,        -- target processor id
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

The at-most-once-per-sync clamp for missed intervals ([[wiki/gotchas/scheduled-hook-idempotency]] — name carried forward, semantics unchanged) is enforced by the engine: it updates `last_fire` to the current time, not the missed-interval time, so multiple missed intervals collapse to one fire. If a processor's cron expression changes, the engine preserves `last_fire`, updates the stored cron and `next_fire` from the current tick time, and skips immediate retroactive execution.

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
  next_attempt_at TEXT NOT NULL,        -- retry cursor; due when <= now
  sent_at         TEXT,
  last_error      TEXT,                 -- nullable; most recent failure message
  run_id          TEXT NOT NULL         -- the RunRecord row that emitted this
);
CREATE INDEX outbox_by_status ON outbox(status, enqueued_at);
CREATE INDEX outbox_by_due ON outbox(status, next_attempt_at, enqueued_at);
```

**Lifecycle:**

1. Processor emits `ExternalActionEffect`.
2. Engine inserts row with `status: "pending"`, `attempts = 0`, and `next_attempt_at = enqueued_at`, then calls the registered capability handler with an engine-owned `AbortSignal`.
3. On success, handler returns `externalId`; engine updates row to `status: "sent"`, `external_id: <id>`.
4. On handler failure or timeout (`attempts < maxAttempts`), engine increments `attempts`, records `last_error`, sets `next_attempt_at = now + bounded exponential backoff`, and leaves the row `pending`. Outbox drains select only rows whose `next_attempt_at <= now`. On explicit dispatch cancellation, the signal is aborted and the row remains `pending` without consuming an attempt.
5. On terminal failure (`attempts >= maxAttempts`), engine marks `status: "failed"`. Recovery follows the engine-asks model: failed rows surface through `dome check` and advanced health/inspect views; `dome.health.outbox-recovery-questions` raises a `QuestionEffect` with options `["retry", "abandon"]`; the user answers via `dome resolve <question-id>`; `dome.health.outbox-recovery-answer` emits an `OutboxRecoveryEffect`; the engine-owned outbox sink applies the mutation. See [[wiki/specs/cli]] §"`dome resolve`" and [[wiki/gotchas/outbox-stuck]].

This is the structural fence behind [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]] and [[wiki/gotchas/outbox-stuck]].

## Rebuild path

`dome rebuild` walks the current adopted commit's tree and re-runs every deterministic adoption-phase processor that contributes to projections, then re-runs deterministic garden-phase processors that produce projection outputs (Facts, Diagnostics, Questions). A garden processor is rebuild-eligible only when it explicitly declares `execution.class: deterministic`, has signal/path triggers, and declares only projection-safe capabilities (`read`, `graph.write`, `search.write`, `question.ask`). The rebuild does NOT re-run processors that produced patches (those patches already landed in adopted commits), does NOT enqueue jobs, does NOT read or mutate operational recovery state, does NOT re-fire external actions (the outbox is preserved), and does NOT make fresh model calls. LLM-derived durable claims must either be materialized into adopted markdown with SourceRefs or treated as cache entries that can be dropped and regenerated only by an explicit non-rebuild garden run.

```text
dome rebuild
  → delete projection.db
  → recreate schema
  → walk wiki/, raw/, inbox/, notes/ at the current adopted commit
    → for each file, synthesize the trigger payload and fire the relevant adoption-phase processors
    → write resulting FactEffect / DiagnosticEffect / SearchDocumentEffect rows
  → re-run deterministic, projection-safe garden-phase emitters only
  → emit `engine.projection.rebuilt` event
```

The rebuild is **idempotent** — running it twice in succession produces byte-equivalent `.db` files (modulo `written_at` timestamps). Any processor that depends on time, random values, network responses, or fresh LLM output is not eligible for automatic rebuild.

Projection rebuild is also **single-writer at the host boundary**. Local
surfaces such as `dome sync`, `dome rebuild`, and command-triggered views may
all notice stale projection cache keys at once, especially immediately after a
bundle/config change. They serialize on `.dome/state/locks/projection-rebuild.lock`
before dropping and recreating projection tables, so concurrent CLI/view
commands cannot interleave `resetProjectionDb` and effect routing into
duplicated facts or FTS rows.

The engine may run this same rebuild path automatically after adoption when a
projection-global config file changes. For example, editing
`.dome/page-types.yaml` can clear or create frontmatter diagnostics for pages
that were not edited in the same commit, so incremental row replacement is not
the correctness boundary for that change.

Wall-clock cost scales with vault size + processor count. For a typical user vault (hundreds to low thousands of pages, a dozen processors), rebuild is seconds. For a 50k-page vault, rebuild is a couple of minutes. The user-facing UX is "you can always wipe and rebuild" — slow but correct.

This rebuild guarantee applies only to `projection.db`. Operational SQLite
files (`answers.db`, `outbox.db`, `runs.db`) carry user decisions, external
action state, and audit history that cannot be derived from markdown. Unknown
schema mismatches in those files are refused and reported by `dome doctor`
before the runtime opens them for mutation; they are not auto-wiped.

## Schema migrations

Schema migrations are **the rebuild**. The projection store does not carry a schema-migration system; when the schema changes (Dome SDK version bump introducing a new column or table), the engine detects schema-version mismatch on `openVault` and triggers `dome rebuild` automatically, surfacing a one-line message:

```text
dome: projection schema changed (v3 → v4); rebuilding (~30s for this vault)...
```

The schema version is the sha256 of the concatenated `CREATE TABLE` /
`CREATE INDEX` / `CREATE VIRTUAL TABLE` statements. A version row in
`projection_meta` stores it. Mismatch → wipe + rebuild.

The opener also validates the live projection table shape before any
projection-backed surface reads rows. This is intentionally redundant with the
schema hash: it catches old or partially migrated `projection.db` files whose
`projection_meta` row is missing, misleading, or written by a pre-upgrade host.
Missing required projection columns are treated the same as a schema mismatch:
wipe the rebuildable projection tables, recreate the current schema, and report
the projection as stale so the host/CLI can rebuild from adopted markdown.

This is what [[wiki/gotchas/projection-schema-skew]] documents — and the automatic rebuild is the mitigation. The user never edits schemas; they just see a "rebuilding..." message after a SDK upgrade.

## Query API (the view-phase and garden-phase reading surface)

View-phase processors (and, since the morning-brief work, garden-phase processors — both run over adopted state) read from the projection store via the query API exposed in `ProcessorContext`; adoption-phase processors never receive it:

```ts
interface ProjectionQueryView {
  searchDocuments(input: {
    query: string;
    category?: string;
    type?: string;
    limit?: number;
  }): ReadonlyArray<SearchMatch>;
  documentsByPath(paths: ReadonlyArray<string>): ReadonlyArray<SearchMatch>;
  facts(filter?: {
    predicate?: string;
    subjectKind?: "page" | "task" | "entity";
    subjectId?: string;
  }): ReadonlyArray<FactEffect>;
  diagnostics(filter?: {
    severity?: "info" | "warning" | "error" | "block";
    processorId?: string;
  }): ReadonlyArray<DiagnosticEffect>;
  questions(filter?: { resolved?: boolean }): ReadonlyArray<ProjectionQuestion>;
}
```

`searchDocuments` performs FTS lookup; `documentsByPath` returns adopted search documents for exact paths already identified by projection memory such as facts, questions, or diagnostics. The query API is read-only. View-phase processors don't write to the projection store directly — they emit ViewEffect with the assembled response; the engine returns it to the caller.

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
