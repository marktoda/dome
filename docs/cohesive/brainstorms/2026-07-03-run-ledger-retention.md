# Run-ledger retention: safe by construction, automatic by default (new vaults)

**Date:** 2026-07-03
**Status:** design, approved direction (recommended options; Mark AFK — posture choices are reversible config/copy) — ready for implementation plan
**Trigger:** the work vault's `runs.db` hit **2.7 GB** and filled the disk on 2026-07-02, killing both serve daemons (ENOSPC → launchd penalty box). Profile: 194k `runs` rows + **10M `capability_uses` rows**, `trigger_payload_json` 547 MB (rows up to 131 KB), `effect_hashes_json` 648 MB; the `dome.health` recovery trio (cron `* * * * *`) writes a ~4.3k rows/day floor on a quiet vault. This promotes the parked "vault auto-gc / doctor probe" follow-up ([[dome-sdk-followups-2026-06-12]] backlog) to done.

## What already exists (build on, don't reinvent)

`src/ledger/runs.ts` ships a complete manual retention path: `RETENTION_ELIGIBLE_RUN_WHERE_SQL` (terminal + boring rows only: `succeeded`, or `skipped` with no error), `planRunLedgerRetention` (dry-run), `pruneRunLedger` (children-first delete inside `BEGIN IMMEDIATE`, optional `VACUUM`), and the CLI `dome repair run-ledger --older-than-days N [--apply] [--vacuum]`. The spec (`docs/wiki/specs/run-ledger.md` §Retention) names a `ledger.retention_days` config knob that was **never wired**, and the engine never prunes automatically.

The invariant [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]] constrains **recording**, not retention — deleting terminal, consumed rows is permitted; the "default retention: forever" line in the spec is a default, not an invariant.

## Two latent hazards in the existing eligibility SQL (fix first)

1. **Scheduler cursor fallback.** After a projection rebuild, `latestScheduleRunStartedAt` recovers each scheduled processor's last-fire time from its newest `trigger_kind='schedule'` ledger row (`src/engine/operational/scheduler.ts` ~247). The current predicate can delete that row → the nightly LLM job re-fires (the documented "consolidate re-charged 11×" incident class).
2. **Failure supersession.** `latestActiveProblemRuns` suppresses an old failed/timed-out row only while a **newer run of the same processor** exists. The current predicate can delete that newer success → a long-resolved failure resurfaces as active attention in `dome check`/`status`.

## Design

### 1. Safe-by-construction eligibility (fixes both hazards, CLI inherits)

Extend `RETENTION_ELIGIBLE_RUN_WHERE_SQL` with two supersession guards — a row is eligible only if:

- a **newer run of the same processor** exists (protects failure supersession and, incidentally, `status`'s newest-run views), and
- when the row is `trigger_kind='schedule'`: a **newer schedule-triggered run of the same processor** exists (protects the scheduler fallback).

Both as correlated `EXISTS` subqueries against `runs` (the `runs_by_processor(processor_id, started_at)` index serves them). No behavior change for non-eligible statuses: failed / timed_out / cancelled / queued / running / reason-bearing skipped rows remain never-pruned, as today.

### 2. Wire `ledger.retention_days`; auto-prune in the daemon

- **Config:** new optional top-level `ledger:` section in vault config, parsed into `RuntimeConfig` (`src/engine/core/capability-policy.ts`): `retention_days` — positive integer, or absent/null = retain forever. **Engine built-in default: forever** (spec-compliant; existing vaults unchanged).
- **Template:** `dome init`'s `default-vault-config.ts` ships a live block —
  ```yaml
  ledger:
    # Prune succeeded/no-op run-ledger rows older than this many days (audit
    # rows for failures, timeouts, and each processor's newest runs are always
    # kept). Comment out to retain forever.
    retention_days: 30
  ```
- **Scheduling:** in-process, daemon-only — `dome serve` runs one retention pass on its **first operational tick** and then **every 24 h of process uptime**. No persisted "last pruned" state (that would require a ledger DDL change on a REFUSE-policy store); a serve restart pruning once more is harmless (idempotent, cheap when nothing is eligible). One-shot `dome sync` does **not** auto-prune. The pass logs one summary line when it pruned anything (rows + capability uses); silent when nothing eligible.
- **No VACUUM in the auto path** — freed pages recycle, so the file plateaus at the retention window's working size. Disk reclamation stays explicit: `dome repair run-ledger --apply --vacuum` (exclusive lock at an operator-chosen moment).

### 3. Doctor probe: ledger growth finding

A doctor/health finding on `runs.db` file size: `warning` when the file exceeds a threshold (default 512 MB) — message names the size, whether `ledger.retention_days` is configured, and the two fixes (set the knob; `dome repair run-ledger --apply --vacuum` to reclaim). `info`-quiet below threshold. This is the "auto-gc / doctor probe" the June-12 backlog wanted; it also catches vaults that opted out of retention.

### 4. Docs

`docs/wiki/specs/run-ledger.md` §Retention updated: knob is wired; daemon auto-prunes daily when set; eligibility now protects newest-per-processor and newest-schedule-per-processor rows; default remains forever, `dome init` template ships 30.

## Out of scope (recorded follow-ups, deliberately not here)

- **Fat-row source reduction** — capping `trigger_payload_json` (131 KB rows) changes what `dome inspect runs` can show for history: an audit-fidelity tradeoff needing its own pass.
- **`dome.health` trio cadence** (`* * * * *` → e.g. `*/5`) — shipped-bundle behavior change for all vaults; separate decision.
- Retention for `outbox.db` / `answers.db` (small today; answers are human decisions — likely never auto-pruned).
- A wider "prune failed rows too" operator tool (the existing comment anticipates it; not needed now).

## Operational step (post-merge, work vault)

One-time `dome repair run-ledger --older-than-days 30 --apply --vacuum` with the daemon briefly stopped (bootout → repair → bootstrap) to reclaim the 2.7 GB, using the **fixed** predicate. Then the daemon's daily pass keeps it flat.

## Testing

- Predicate: newest run per processor is never eligible; newest schedule-triggered run per processor is never eligible even when older than cutoff; an older schedule row WITH a newer schedule row IS eligible; failed/timed_out/running rows remain ineligible regardless of age; `capability_uses` children of pruned rows go, others stay.
- Config: `ledger.retention_days` parses (absent → forever; malformed → degrade-not-crash with a warning finding, matching the config-parsing house style); template config parses with 30; engine default has no retention.
- Serve integration: with retention configured and eligible rows present, the daemon's first operational tick prunes and logs; a second tick within 24 h does not re-run the pass.
- Doctor: oversized file → warning finding with both remedies; small file → no finding.

## Acceptance criteria

1. The two supersession guards are in the shared WHERE; `dome repair run-ledger` and the auto path both use it.
2. `ledger.retention_days` wired end-to-end (parse → runtime config → daemon pass); engine default = forever; template = 30.
3. Daemon prunes on first operational tick + every 24 h, no VACUUM, one summary log line.
4. Doctor warns on oversized runs.db with accurate remedies.
5. Work vault (post-merge, operational): runs.db reclaimed to a bounded size and stays flat.
