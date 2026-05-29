// ledger-capability-uses: per-row insert + read for the `capability_uses`
// table. Owns the privileged-runtime/effect → ledger boundary: every time
// the capability broker evaluates an effect, or the runtime evaluates a
// non-effect capability such as `model.invoke`, it writes one row here
// describing the capability, the resource touched, and the outcome
// ("allowed" | "downgraded" | "denied").
//
// Normative references:
//   - docs/wiki/specs/run-ledger.md §"Tables — capability_uses" (column
//     shape + outcome enum + the join-by-`run_id` audit pattern).
//   - docs/wiki/specs/capabilities.md §"Enforcement chokepoint" — the
//     broker writes one row per effect attempted; runtime-only powers such
//     as `model.invoke` write rows at their context boundary. The union of
//     rows joined to a run gives "what did this processor reach."
//
// Structural fences this file upholds:
//   - docs/wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED.md §"Structural
//     enforcement" §2: "The applier writes `capability_uses` rows per
//     effect. Joined to the RunRecord by `run_id`." This file owns the
//     SQL that lands those rows, plus equivalent runtime-capability rows.
//
// House-style notes (mirrors src/projections/diagnostics.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - INSERT uses a simple `INSERT` (no `OR IGNORE`): the table has no
//     UNIQUE constraint — multiple capability uses per run are normal
//     (one row per effect-evaluation attempt). The `id INTEGER PRIMARY KEY
//     AUTOINCREMENT` is sqlite-managed.
//   - Returned arrays are `Object.freeze`'d.
//   - `noUncheckedIndexedAccess` discipline: row arrays are mapped
//     functionally; no index access into raw `.all()` results.

import type { LedgerDb } from "./db";
import type { RunId } from "./runs";

// ----- Public types ---------------------------------------------------------

/**
 * The closed set of broker outcomes per spec §"Tables — capability_uses"
 * `outcome` column.
 *
 * - `allowed`     — the broker passed the effect through unchanged.
 * - `downgraded`  — the broker rewrote the effect to a less-privileged
 *                   form (e.g., `patch.auto` → `patch.propose` because
 *                   the processor's tier didn't permit auto-apply).
 * - `denied`      — the broker refused the effect; the processor saw a
 *                   capability-denied error.
 */
export type CapabilityOutcome = "allowed" | "downgraded" | "denied";

export type RecordCapabilityUseOpts = {
  readonly runId: RunId;
  /** Canonical capability key, e.g., "patch.auto:wiki/**", "graph.write:dome.tasks". */
  readonly capability: string;
  /** The specific resource touched (path, namespace, etc.) or null. */
  readonly resource: string | null;
  readonly outcome: CapabilityOutcome;
  readonly recordedAt: Date;
};

/**
 * Row shape returned by `capabilityUsesByRun`. Nullable columns are
 * typed `T | null` (not `T | undefined`) so SQL NULL maps cleanly under
 * `exactOptionalPropertyTypes`.
 */
export type CapabilityUseRow = {
  readonly id: number;
  readonly runId: RunId;
  readonly capability: string;
  readonly resource: string | null;
  readonly outcome: CapabilityOutcome;
  readonly recordedAt: string;
};

// ----- SQL ------------------------------------------------------------------

const INSERT_CAPABILITY_USE_SQL = `
INSERT INTO capability_uses (
  run_id, capability, resource, outcome, recorded_at
) VALUES (?, ?, ?, ?, ?)
`.trim();

const SELECT_BY_RUN_SQL = `
SELECT id, run_id, capability, resource, outcome, recorded_at
FROM capability_uses
WHERE run_id = ?
ORDER BY id
`.trim();

// ----- Raw row shape --------------------------------------------------------

type CapabilityUseRawRow = {
  readonly id: number;
  readonly run_id: string;
  readonly capability: string;
  readonly resource: string | null;
  readonly outcome: string;
  readonly recorded_at: string;
};

// ----- Public functions -----------------------------------------------------

/**
 * Insert one capability_use row. The capability broker calls this once
 * per effect-evaluation attempt, and the runtime calls it for non-effect
 * privileged context actions such as model.invoke. Multiple rows per run
 * are normal.
 *
 * Throws on SQLite-level failure (disk full, schema-mismatch, etc.).
 */
export function recordCapabilityUse(
  db: LedgerDb,
  opts: RecordCapabilityUseOpts,
): void {
  db.raw.query(INSERT_CAPABILITY_USE_SQL).run(
    opts.runId,
    opts.capability,
    opts.resource,
    opts.outcome,
    opts.recordedAt.toISOString(),
  );
}

/**
 * Read every capability_use row for a given run, ordered by insert order
 * (the table's autoincrement `id`). Returns a frozen array.
 *
 * Wired to the audit surface: "what did this processor reach during the
 * run." Joining this read with `getRun(...)` gives the full per-run
 * forensics view.
 */
export function capabilityUsesByRun(
  db: LedgerDb,
  runId: RunId,
): ReadonlyArray<CapabilityUseRow> {
  const rows = db.raw
    .query<CapabilityUseRawRow, [string]>(SELECT_BY_RUN_SQL)
    .all(runId);
  return Object.freeze(rows.map(rowToCapabilityUseRow));
}

// ----- internals ------------------------------------------------------------

function rowToCapabilityUseRow(row: CapabilityUseRawRow): CapabilityUseRow {
  return Object.freeze({
    id: row.id,
    runId: row.run_id as RunId,
    capability: row.capability,
    resource: row.resource,
    outcome: narrowOutcome(row.outcome),
    recordedAt: row.recorded_at,
  });
}

/**
 * Narrow the raw `outcome` string to the closed `CapabilityOutcome`
 * union. The DDL doesn't carry a CHECK constraint on `outcome` (v1
 * simplicity); this function is the read-side fence.
 */
function narrowOutcome(s: string): CapabilityOutcome {
  switch (s) {
    case "allowed":
    case "downgraded":
    case "denied":
      return s;
    default:
      throw new Error(`ledger.capability-uses: unknown outcome '${s}'`);
  }
}
