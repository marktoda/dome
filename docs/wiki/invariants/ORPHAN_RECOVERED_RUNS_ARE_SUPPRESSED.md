---
type: invariant
created: 2026-06-19
updated: 2026-06-19
sources:
  - "[[cohesive/design-brief-cockpit-and-cli]]"
description: Runs failed by the dome.health orphan-recovery path are suppressed from dome status problem counts and latestActiveProblemRuns so the health machinery cannot loop on its own recovery evidence
enforced_by:
  - tests/ledger/runs.test.ts
  - tests/invariants/orphan-recovered-runs-are-suppressed.test.ts
tier: shipped-default
---

# ORPHAN_RECOVERED_RUNS_ARE_SUPPRESSED

**Tier:** Shipped default — always active; no config knob.

**Statement:** A run that was intentionally failed by the dome.health orphan-recovery path — either via the engine-crash bulk transition (`FAIL_ORPHANS_SQL`, error matching `LIKE 'orphaned-run:%'`) or via the health answer processor (`ORPHAN_RUN_RECOVERY_ERROR_REASON`, error `= 'dome.health: mark orphaned processor run failed'`) — does NOT appear in `latestActiveProblemRuns` or the `countLatestActiveProblemRuns` figure surfaced by `dome status`. The row remains in the ledger for audit purposes; it is only hidden from the live-problem surface.

**Why:** Orphan-recovery runs are closure evidence, not new problems. Without suppression, each resolved orphan creates a persistent failed run that `dome status` promotes into an attention item, which the health machinery interprets as a new orphan to resolve — a tight loop. The suppression is the circuit-breaker: "this was intentionally closed; do not re-raise."

**Structural enforcement:**

1. **`LATEST_ACTIVE_PROBLEM_WHERE_SQL` excludes recovery rows.** The SQL filter in `src/ledger/runs.ts` contains an `AND NOT (status = 'failed' AND (error LIKE 'orphaned-run:%' OR error = '<const>'))` clause. The `LIKE` arm covers bulk engine-crash closures; the `= '<const>'` arm covers the health processor's per-run closures.

2. **`ORPHAN_RUN_RECOVERY_ERROR_REASON` is the single source of truth.** The exact prose reason written by the health answer processor is exported from `src/ledger/runs.ts` as `ORPHAN_RUN_RECOVERY_ERROR_REASON` and imported by `assets/extensions/dome.health/processors/orphan-run-recovery-answer.ts`. The SQL filter interpolates the same const. A rename is a compile error at all three sites — silent drift is impossible.

3. **`isRecoveredOrphanRun` mirrors the SQL filter.** The in-process helper used by `isActiveProblemRun` applies the same two-arm logic (string prefix check + const equality) so in-memory evaluations and SQL queries agree.

**Error-column note:** The orphan-recovery paths write PLAIN TEXT to the `error` column (not JSON). The `LIKE 'orphaned-run:%'` and `= ORPHAN_RUN_RECOVERY_ERROR_REASON` arms are the complete suppression surface. A migration to structured JSON error codes for these rows is deferred — the column shape for the orphan paths is plain text and bolting on `json_extract` without a migration would only match newly-written rows.

**Test guarantee:** `tests/invariants/orphan-recovered-runs-are-suppressed.test.ts` is the AC3-lockstep marker that this doc is present. Behavioral coverage lives in `tests/ledger/runs.test.ts` (describe block `ORPHAN_RECOVERED_RUNS_ARE_SUPPRESSED`).

**Related:**
- [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]
- [[wiki/specs/run-ledger]]
