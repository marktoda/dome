---
type: spec
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]", "[[v1]]"]
---

# Run ledger

This spec is normative for Dome's processor-run history. The **run ledger** is a Bun.sqlite-backed table that records one row per [[wiki/specs/processors|processor]] invocation, regardless of outcome. It is the audit surface for "what did Dome do, when, with what result, at what cost."

Pinned by [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]].

## Why a separate ledger (not just git trailers)

[[wiki/specs/adoption]] §"Engine commit trailers" pins the four-trailer convention: every engine commit carries `Dome-Run`, `Dome-Extension`, `Dome-Base`, `Dome-Source-Head` in the message body. `git log --grep="Dome-Run:"` yields the engine history.

The ledger augments the trailers with data git cannot carry:

| Data | Where it lives | Why |
|---|---|---|
| Commit provenance (run id, extension, base, source head) | git trailers | Reachable via `git log`; survives clone; readable without Dome |
| Run status (queued / running / succeeded / failed / skipped) | ledger | git only records successful commits; failed runs leave no trace |
| Effect hashes | ledger | what the run produced, even when no commit was made |
| Capability uses | ledger | audit surface for "this processor wrote to dome.tasks namespace" |
| Cost (LLM tokens × pricing) | ledger | per-processor spend tracking |
| Wall-clock duration | ledger | performance debugging |
| Error message | ledger | failed-run forensics |

Successful adoption-phase runs that contribute to a closure commit appear in **both** surfaces. The `Dome-Run` trailer is the join key — the ledger row's `id` matches the trailer's value. This is the dual-surface enforcement of [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]].

## File layout

```
<vault>/.dome/state/runs.db
```

Separate SQLite file from `projection.db` so processor-run audit history is not wiped by a projection rebuild. The file is gitignored ([[wiki/specs/vault-layout]] §"Derived operational state") but persists across SDK upgrades, projection schema changes, and `dome rebuild`.

## Tables

### `runs`

```sql
CREATE TABLE runs (
  id                   TEXT PRIMARY KEY,         -- run_<unix-ms>_<6-char-rand>
  proposal_id          TEXT,                     -- nullable; null for view-phase / scheduled-cron-only runs
  processor_id         TEXT NOT NULL,
  processor_version    TEXT NOT NULL,
  phase                TEXT NOT NULL,            -- "adoption" | "garden" | "view"
  input_commit         TEXT NOT NULL,            -- the snapshot OID the processor ran against
  output_commit        TEXT,                     -- nullable; set when run contributed to a closure commit
  status               TEXT NOT NULL,            -- "queued" | "running" | "succeeded" | "failed" | "skipped"
  effect_hashes_json   TEXT NOT NULL,            -- JSON-encoded string[] (sha256 of each emitted effect)
  cost_usd             REAL,                     -- nullable; populated by model.invoke usage
  duration_ms          INTEGER,                  -- nullable; null while running
  error                TEXT,                     -- nullable; failure detail
  trigger_kind         TEXT NOT NULL,            -- "signal" | "path" | "schedule" | "command"
  trigger_payload_json TEXT NOT NULL,            -- the input that fired the trigger
  started_at           TEXT NOT NULL,
  finished_at          TEXT
);
CREATE INDEX runs_by_proposal ON runs(proposal_id, started_at);
CREATE INDEX runs_by_processor ON runs(processor_id, started_at);
CREATE INDEX runs_by_status ON runs(status, started_at);
```

### `capability_uses`

```sql
CREATE TABLE capability_uses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  capability      TEXT NOT NULL,                 -- e.g., "patch.auto:wiki/**", "graph.write:dome.tasks"
  resource        TEXT,                          -- nullable; the specific resource touched (path, namespace, etc.)
  outcome         TEXT NOT NULL,                 -- "allowed" | "downgraded" | "denied"
  recorded_at     TEXT NOT NULL
);
CREATE INDEX capability_uses_by_run ON capability_uses(run_id);
```

Capability uses are written by the broker (per [[wiki/specs/capabilities]] §"Enforcement chokepoint") at the moment of effect application. The broker writes one row per effect attempted; the union of rows joined to a run gives the full "what did this processor reach" picture.

## Run lifecycle

```text
queued      Engine enqueued the processor invocation; not yet running.
running     Processor.run() is executing.
succeeded   Processor.run() returned without throwing; effects were emitted (zero or more).
failed      Processor.run() threw or returned an invalid Effect; the run was abandoned.
skipped    Idempotency dedup short-circuited the run (cached result reused per processor_versions_hash).
```

The engine writes `queued` rows synchronously when enqueueing; updates to `running` at the start of `Processor.run()`; updates to `succeeded` / `failed` at the end. Crashes between `running` and the terminal state leave orphaned `running` rows — `dome show runs --status running` lists them. Recovery follows the engine-asks model (v1.x): the deferred `dome.health.detect-orphan-runs` scheduled garden-phase processor emits a `QuestionEffect` per orphan row; the user answers `fail` (transition to `failed`) or `keep` (waiting on a long-running operation) via `dome answer`; the answer-handler processor applies the mutation.

## Cost tracking

`cost_usd` is populated by the `modelInvoke` wrapper when a processor calls an LLM. Every `modelInvoke` call records the prompt-token-count, completion-token-count, and the model's pricing snapshot; the cost is summed across all invocations within the run.

The cost surface drives `model.invoke.maxDailyCostUsd` enforcement (per [[wiki/specs/capabilities]] §"model.invoke"): the broker queries `SUM(cost_usd) FROM runs WHERE processor_id = ? AND started_at >= today` before each `modelInvoke` call; if the sum + the estimated next-call cost exceeds the daily cap, the call is refused and the processor sees a capability-denied error.

## Query surface (CLI)

```text
dome show runs                        # recent runs across all processors
dome show runs --processor dome.intake.extract-capture
dome show runs --status failed --since 24h
dome show cost                        # per-processor spend, current day + last 7 days (v1.x subject)
dome show runs --status running       # runs stuck in "running" state (engine crash); the dedicated
                                      # `orphan-runs` subject ships with the dome.health bundle (v1.x)
```

The ledger is also queryable via the MCP server's `dome.runs.list` tool when MCP is mounted (per [[wiki/specs/mcp-surface]]).

## Retention

Default retention: **forever**. The ledger is small (typically a few KB per run) and the audit value compounds over time. Users with vaults that grow into millions of runs may opt into a retention policy via `<vault>/.dome/config.yaml`:

```yaml
ledger:
  retention_days: 365
  retention_failed_runs_days: 90
```

The engine prunes rows older than the policy at the start of each `dome sync`. Pruning never touches `failed` runs unless `retention_failed_runs_days` is set explicitly — failed-run forensics are too valuable to drop silently.

## What the ledger cannot do

- **Replace git trailers.** Successful engine commits MUST carry the four Dome-* trailers in their message body. The ledger is the audit surface; the trailers are the durable-in-git provenance surface. Both are required.
- **Live in markdown.** `log.md` is a *projection* of the ledger maintained by the `dome.log` extension's adoption-phase processor. The ledger is the source of run truth; `log.md` is its human-readable view, committed for browseability. Removing or corrupting `log.md` rebuilds it from the ledger; corrupting the ledger requires rebuild from git trailers (lossy — capability uses and costs are unrecoverable for past runs).
- **Survive vault deletion.** The ledger lives in `<vault>/.dome/state/`; it's a per-vault history. Multi-vault aggregation is not in scope.

## Related

- [[wiki/specs/processors]] — runs are processor invocations
- [[wiki/specs/effects]] — effect hashes index effect provenance
- [[wiki/specs/capabilities]] — capability uses join here
- [[wiki/specs/adoption]] §"Engine commit trailers" — the git-side surface
- [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]] — structural fence
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]] — the trailer side of the dual surface
- [[wiki/invariants/LOG_IS_APPEND_ONLY]] — log.md is a ledger projection; both are append-only
