// ledger-retention: the automatic-policy seam over the run-ledger's
// existing explicit-prune SQL.
//
// `src/ledger/runs.ts` already owns `planRunLedgerRetention` /
// `pruneRunLedger` — the SQL that deletes old `succeeded` runs and
// idempotency-style `skipped` runs (`error IS NULL`), used today by the
// operator-driven `dome repair run-ledger --older-than-days <n> --apply`
// (docs/wiki/specs/run-ledger.md §"Retention"). That eligibility predicate
// already excludes every diagnostic-value terminal row — `failed`,
// `timed_out`, `cancelled`, and reason-bearing `skipped` rows are NEVER
// eligible, regardless of age. Since the processor-quarantine store
// (`src/engine/operational/quarantine-store.ts`) tracks
// (processorId, processorVersion, phase, triggerHash) counters with no
// `run_id` back-reference, there is no row-level join from "open quarantine
// state" to a specific `runs` row to build a narrower per-row exception —
// but there doesn't need to be one: quarantine state is only ever load-
// bearing against `failed` rows, and `failed` rows are categorically
// preserved by the existing predicate. So "rows referenced by open
// quarantine state survive" already holds, as a strict corollary of "all
// failure-forensics rows survive," which is a SAFER guarantee than a
// per-row join would give (a quarantine counter that later gets cleared
// doesn't retroactively make its evidence prunable).
//
// This module owns exactly the automatic-policy layer `runs.ts` does not:
// turning `{ retentionDays, now }` into the `cutoffIso` the existing SQL
// wants, and deciding when the (expensive) VACUUM pays for itself. It does
// NOT re-implement the DELETE statements — that SQL, and its eligibility
// predicate, stay single-sourced in `runs.ts`.
//
// Naming note: the brief for this task names the function `pruneRunLedger`.
// That name is already taken by `runs.ts`'s cutoff/vacuum-shaped export
// (wired into `dome repair run-ledger`) — reusing it here would shadow-clash
// on any import site that needs both the manual CLI path and the automatic
// policy path. This file exports `pruneRunLedgerRetention` instead and
// delegates its SQL to the existing `pruneRunLedger`.
//
// House-style notes (mirrors src/ledger/runs.ts):
//   - `type X = { ... }` aliases, every field `readonly`, frozen returns.
//   - No imports from `src/engine/`, `src/processors/`, or `src/core/effect`
//     — this stays inside the ledger's SQLite boundary.

import type { LedgerDb } from "./db";
import { pruneRunLedger } from "./runs";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deleted-row threshold past which the (expensive) `VACUUM` pass runs.
 * Below this, pages freed by DELETE stay in SQLite's internal freelist for
 * reuse by future INSERTs — cheap, and avoids a daily full-file rewrite for
 * ordinary-sized prunes.
 */
export const RUN_LEDGER_RETENTION_VACUUM_THRESHOLD = 10_000;

export type RunLedgerRetentionPolicyOpts = {
  /** Days of history to keep. `0` disables automatic retention entirely. */
  readonly retentionDays: number;
  readonly now: Date;
};

export type RunLedgerRetentionPolicyResult = {
  /** Total rows removed (pruned `runs` rows plus their `capability_uses` children). */
  readonly deleted: number;
  /**
   * SQLite pages reclaimed by `VACUUM`. Zero when `deleted` stayed at or
   * under `RUN_LEDGER_RETENTION_VACUUM_THRESHOLD` (no vacuum ran) or when
   * nothing was eligible.
   */
  readonly reclaimedPages: number;
};

/**
 * Apply the automatic run-ledger retention policy: compute the cutoff from
 * `retentionDays`, delete eligible rows via the existing `runs.ts` SQL, and
 * vacuum only when the delete count crosses the threshold.
 *
 * `retentionDays <= 0` is a hard disable — no cutoff is computed, no SQL
 * runs, `{ deleted: 0, reclaimedPages: 0 }` is returned immediately. This is
 * the config contract: `ledger.retention_days: 0` means "never prune."
 */
export function pruneRunLedgerRetention(
  db: LedgerDb,
  opts: RunLedgerRetentionPolicyOpts,
): RunLedgerRetentionPolicyResult {
  if (opts.retentionDays <= 0) {
    return Object.freeze({ deleted: 0, reclaimedPages: 0 });
  }

  const cutoffIso = new Date(
    opts.now.getTime() - opts.retentionDays * DAY_MS,
  ).toISOString();

  const pagesBefore = pageCount(db);
  const result = pruneRunLedger(db, { cutoffIso, vacuum: false });
  const deleted = result.prunedRuns + result.prunedCapabilityUses;

  if (deleted <= RUN_LEDGER_RETENTION_VACUUM_THRESHOLD) {
    return Object.freeze({ deleted, reclaimedPages: 0 });
  }

  // Prefer the cheap incremental vacuum; the ledger's DDL (src/ledger/db.ts)
  // doesn't set `PRAGMA auto_vacuum = INCREMENTAL` at creation time (SQLite
  // only honors that pragma when set BEFORE any tables exist), so on every
  // ledger created today this is a no-op and the full VACUUM below does the
  // actual reclaiming. Kept explicit — a future DDL generation that enables
  // incremental auto-vacuum benefits here without touching this file, and
  // running it first never hurts (VACUUM after is always correct).
  db.raw.exec("PRAGMA incremental_vacuum");
  db.raw.exec("VACUUM");
  const pagesAfter = pageCount(db);

  return Object.freeze({
    deleted,
    reclaimedPages: Math.max(0, pagesBefore - pagesAfter),
  });
}

function pageCount(db: LedgerDb): number {
  const row = db.raw
    .query<{ readonly page_count: number }, []>("PRAGMA page_count")
    .get();
  return row?.page_count ?? 0;
}
