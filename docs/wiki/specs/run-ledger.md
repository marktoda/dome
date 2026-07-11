---
type: spec
created: 2026-05-27
updated: 2026-07-11
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
  - "[[v1]]"
description: "runs.db audit ledger: one row per processor invocation plus CapabilityUse rows; complements Dome-* trailers and survives projection rebuilds"
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
| Run status (queued / running / succeeded / failed / skipped / timed_out / cancelled) | ledger | git only records successful commits; failed runs leave no trace |
| Effect hashes | ledger | what the run produced, even when no commit was made; capped at `EFFECT_HASHES_MAX` (100) with a `…+N more effect hashes` count sentinel past the cap |
| Capability uses | ledger | audit surface for "this processor wrote to dome.tasks namespace" |
| Cost (LLM tokens × pricing) | ledger | per-processor spend tracking |
| Wall-clock duration | ledger | performance debugging |
| Error message / not-invoked reason | ledger | failed-run and skipped-run forensics |

Successful adoption-phase runs that contribute engine patches appear in **both** surfaces. In the current plumbing path, each patch commit carries the producing run's `Dome-Run` trailer; the run ledger also back-fills `output_commit` to the Proposal's final closure chain head for proposal-level lookup. This is the dual-surface enforcement of [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]].

## File layout

```
<vault>/.dome/state/runs.db
```

Separate SQLite file from `projection.db` so processor-run audit history is not wiped by a projection rebuild. The file is gitignored ([[wiki/specs/vault-layout]] §"Derived operational state") but persists across SDK upgrades, projection schema changes, and `dome rebuild`.

`runs.db` is unrebuildable operational history. Unknown schema-hash
mismatches are refused rather than wiped; `dome doctor` reports the stored and
expected hashes so the operator can run a compatible Dome version or an
explicit migration without losing rows.

## Tables

### `runs`

```sql
CREATE TABLE runs (
  id                   TEXT PRIMARY KEY,         -- run_<unix-ms>_<6-char-rand>
  proposal_id          TEXT,                     -- nullable; null for view-phase / scheduled garden runs
  processor_id         TEXT NOT NULL,
  processor_version    TEXT NOT NULL,
  phase                TEXT NOT NULL,            -- "adoption" | "garden" | "view"
  input_commit         TEXT NOT NULL,            -- the snapshot OID the processor ran against
  output_commit        TEXT,                     -- nullable; set when run contributed to a closure commit
  status               TEXT NOT NULL,            -- "queued" | "running" | "succeeded" | "failed" | "skipped" | "timed_out" | "cancelled"
  effect_hashes_json   TEXT NOT NULL,            -- JSON-encoded string[] (sha256 of each emitted effect); capped at EFFECT_HASHES_MAX (100), truncated list ends in a "…+N more effect hashes" sentinel
  cost_usd             REAL,                     -- nullable; populated by model.invoke usage
  duration_ms          INTEGER,                  -- nullable; null while running
  error                TEXT,                     -- nullable; failure detail or not-invoked reason JSON
  trigger_kind         TEXT NOT NULL,            -- "signal" | "path" | "schedule" | "answer" | "command"
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

Capability uses are written by the broker (per [[wiki/specs/capabilities]] §"Enforcement chokepoint") at the moment of effect application, and by runtime-only capability boundaries such as `model.invoke` when a processor reaches a privileged context function. The broker writes one row per effect attempted; `model.invoke` writes one row per model-call attempt with the resolved model as `resource` when known. The union of rows joined to a run gives the full "what did this processor reach" picture.

## Run lifecycle

```text
queued      Engine enqueued the processor invocation; not yet running.
running     Processor.run() is executing.
succeeded   Processor.run() returned without throwing and all emitted Effects validated.
failed      Processor.run() threw or returned invalid output; the run was abandoned.
skipped     The run was not invoked. Idempotency dedup leaves error null; policy denial / quarantine records structured reason JSON.
timed_out   The invocation exceeded its phase timeout; late effects were discarded.
cancelled   The engine intentionally stopped the run during shutdown or operator intervention.
```

The engine writes `queued` rows synchronously when enqueueing; updates to `running` at the start of `Processor.run()`; updates to a terminal state at the end. A row may move directly from `queued` to `skipped` when the runtime decides not to invoke the processor. Idempotency skips preserve the historical `error = NULL` shape; policy-denial and quarantine skips write structured reason JSON into `error` so the audit row explains why no processor code ran. Crashes between `running` and the terminal state leave orphaned `running` rows — `dome check` reports them and advanced `dome inspect runs --status running` lists row-level details. Recovery follows the engine-asks model: the `dome.health.orphan-run-recovery-questions` scheduled garden-phase processor emits a `QuestionEffect` per orphan row; the user answers `fail` (transition to `failed`) or `ignore` via `dome resolve`; the answer-handler processor applies the mutation through `RunRecoveryEffect`. The ledger transition is stale-safe: it only mutates the row while `runId`, `startedAt`, `processorId`, `processorVersion`, `phase`, and `status = 'running'` still match the question generation. A `failed` row written by this recovery path is resolved audit history, not an active failed-run attention item; ordinary latest `failed`, `timed_out`, and `cancelled` rows still surface through `dome status` and `dome check`. See [[wiki/specs/processor-execution]] for timeout, cancellation, retry, and quarantine semantics.

## Cost tracking

`cost_usd` is populated by the `modelInvoke` wrapper when a processor calls an LLM provider that reports cost. The cost is summed across all invocations within the run and persisted even when the run fails later due to structured-output parsing, schema mismatch, or a post-call budget denial.

The cost surface backs `model.invoke.maxDailyCostUsd` enforcement (per [[wiki/specs/capabilities]] §"model.invoke"). The runtime sums `cost_usd` for the processor's extension-id prefix since local midnight, adds the current run's in-memory cost, and denies further model calls once the bundle's effective daily cap is spent.

The same column feeds the `dome inspect cost` report ([[wiki/specs/cli]] §"`dome inspect`"): per-processor windowed totals and extension subtotals with a since-midnight split, using the same local-midnight boundary as the budget scopes, so the report and the caps agree on what "today" means. Only cost-bearing rows participate — a NULL `cost_usd` means the run never billed a provider.

## Query surface (CLI)

```text
dome inspect runs                        # recent runs across all processors
dome inspect runs
dome inspect cost [--days N]             # per-processor spend + extension subtotals + grand total, today split (window default 7 days)
dome doctor                              # reports orphan running rows and other health findings
```

The planned MCP adapter does not expose direct ledger queries. Per
[[wiki/specs/mcp-surface]], MCP stays a Recall + view-command adapter; run
ledger forensics remain on the CLI operational surface.

## Retention

Default retention: **forever**. The ledger is small (typically a few KB per run) and the audit value compounds over time. The engine's own built-in default (`DEFAULT_RUNTIME_CONFIG`, used when a vault has no config at all) never prunes — retention is opt-in per vault, not an engine-wide posture.

The vault template shipped by `dome init` opts in at **30 days**:

```yaml
ledger:
  # Prune succeeded/no-op run-ledger rows older than this many days. Audit
  # rows for failures, timeouts, and each processor's newest runs are always
  # kept. Comment out to retain forever; reclaim disk with
  # `dome repair run-ledger --apply --vacuum`.
  retention_days: 30
```

Comment out or remove the key to retain forever. When `ledger.retention_days` is set, `dome serve` prunes automatically: once on the daemon's first workable tick, then every 24 hours thereafter, using the same in-memory cadence as the operational tick (no persisted last-run state — a restart pruning once more is an idempotent no-op when nothing is newly eligible). `dome sync` never prunes; automatic retention is daemon-only. The daily pass never runs `VACUUM` — freed pages recycle in place inside the file, so the `.db` file's on-disk size does not shrink from the daily pass alone.

Retention is a deliberate narrowing of [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]: that invariant is about **writing** — every `Processor.run()` invocation lands exactly one row, no exceptions — not about keeping every row forever. Retention deletes old routine rows; it never skips writing a new one. The two are independent knobs and neither weakens the other. The bounded horizon applies to the `succeeded` / clean-`skipped` subset only; the failure family (`failed`, `timed_out`, `cancelled`, reason-bearing `skipped`) is retained **indefinitely, by design** — those rows are forensics.

Eligibility is narrow and safe by construction: only rows with `finished_at` set, older than the cutoff, and either `status = 'succeeded'` or `status = 'skipped'` with `error IS NULL` (idempotency-style skips) are ever eligible. Failed, timed-out, cancelled, queued, running, and reason-bearing skipped rows are never eligible because they carry active forensics. Two supersession guards additionally protect live behavior regardless of age or status: **a processor's newest run is never eligible** (`latestActiveProblemRuns` suppresses old failures only while a newer same-processor run exists, so deleting the newest success would resurface resolved failures), and **a processor's newest schedule-triggered run is never eligible** (after a projection rebuild the scheduler recovers last-fire times from the ledger via `latestScheduleRunStartedAt`; deleting it would re-fire the job — the 2026-06-10 "consolidate re-charged 11x" incident class).

**Consequence for oversized-ledger recovery:** because both the automatic pass and the manual command share the failure-exempting predicate, a ledger dominated by failure-forensics rows will not shrink from either remedy. That is working as intended — the fix for failure bloat is fixing the failing processor (its rows stop accumulating and the noise stops), not widening what retention may delete. `dome doctor`'s `ledger.oversized` finding includes the retained-forensics row count and says this explicitly, so an operator whose prune "did nothing" isn't left guessing.

The manual command remains the explicit, disk-reclaiming path — same eligibility predicate, operator-controlled cutoff and `--vacuum`:

```sh
dome repair run-ledger --older-than-days 365        # dry-run
dome repair run-ledger --older-than-days 365 --apply
dome repair run-ledger --older-than-days 365 --apply --vacuum
```

The command never creates a missing ledger, defaults to dry-run, and prunes only the rows described above. `--vacuum` is separate and opt-in because SQLite compaction can be expensive; it is the only way to shrink the file on disk, since neither the manual command's non-vacuum runs nor the daemon's daily pass compact.

`dome doctor`/`dome check` additionally emit an informational maintenance
finding when `runs.db` grows past 512 MB regardless of the retention setting
(`ledger.oversized`), naming the actual size, both remedies
(`ledger.retention_days` and `dome repair run-ledger --apply --vacuum`), and
the retained-forensics row count. Disk usage alone does not make the compiler
unhealthy; active failures and timeouts have separate error/warning findings.
Unpruned or slow-growing ledgers remain visible before disk pressure forces
the question, and a failure-dominated ledger is identified as such rather
than leaving the operator to wonder why pruning did nothing.

## What the ledger cannot do

- **Replace git trailers.** Successful engine commits MUST carry the four Dome-* trailers in their message body. The ledger is the audit surface; the trailers are the durable-in-git provenance surface. Both are required.
- **Project into a markdown log.** The once-planned `dome.log` projection of the ledger into `log.md` is retired per [[wiki/invariants/NO_ACCRETING_REGISTRIES]] — `log.md` is frozen. The run ledger is the structured audit surface, engine commit trailers (with the narrative commit body per [[wiki/specs/adoption]] §"Engine commit trailers") are the durable-in-git provenance surface, and `dome log` joins the two on demand ([[wiki/specs/cli]] §"`dome log`"). Corrupting the ledger would require a lossy rebuild from git trailers.
- **Survive vault deletion.** The ledger lives in `<vault>/.dome/state/`; it's a per-vault history. Multi-vault aggregation is not in scope.

## Related

- [[wiki/specs/processors]] — runs are processor invocations
- [[wiki/specs/processor-execution]] — run lifecycle, timeouts, validation, retries, quarantine
- [[wiki/specs/effects]] — effect hashes index effect provenance
- [[wiki/specs/capabilities]] — capability uses join here
- [[wiki/specs/adoption]] §"Engine commit trailers" — the git-side surface
- [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]] — structural fence
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]] — the trailer side of the dual surface
- [[wiki/invariants/LOG_IS_APPEND_ONLY]] — planned log.md projection; current v1 audit uses ledger + git trailers
