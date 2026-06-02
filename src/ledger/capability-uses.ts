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

export type PatchRecordFilter = {
  readonly processorId?: string;
  readonly limit?: number;
};

export type PatchRecord = {
  readonly id: number;
  readonly runId: RunId;
  readonly processorId: string;
  readonly processorVersion: string;
  readonly phase: string;
  readonly status: string;
  readonly capability: string;
  readonly resource: string | null;
  readonly outcome: CapabilityOutcome;
  readonly inputCommit: string;
  readonly outputCommit: string | null;
  readonly effectHashes: ReadonlyArray<string>;
  readonly startedAt: string;
  readonly finishedAt: string | null;
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

const SELECT_PATCH_RECORDS_BASE_SQL = `
SELECT
  capability_uses.id,
  capability_uses.run_id,
  capability_uses.capability,
  capability_uses.resource,
  capability_uses.outcome,
  capability_uses.recorded_at,
  runs.processor_id,
  runs.processor_version,
  runs.phase,
  runs.status,
  runs.input_commit,
  runs.output_commit,
  runs.effect_hashes_json,
  runs.started_at,
  runs.finished_at
FROM capability_uses
JOIN runs ON runs.id = capability_uses.run_id
WHERE capability_uses.capability IN ('patch.auto', 'patch.propose')
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

type PatchRecordRawRow = CapabilityUseRawRow & {
  readonly processor_id: string;
  readonly processor_version: string;
  readonly phase: string;
  readonly status: string;
  readonly input_commit: string;
  readonly output_commit: string | null;
  readonly effect_hashes_json: string;
  readonly started_at: string;
  readonly finished_at: string | null;
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

/**
 * Read patch-attempt provenance by joining capability-use audit rows back to
 * their processor runs. This is intentionally a derived inspection surface:
 * the source of truth remains the run ledger plus git engine trailers.
 */
export function queryPatchRecords(
  db: LedgerDb,
  filter?: PatchRecordFilter,
): ReadonlyArray<PatchRecord> {
  const clauses: string[] = [];
  const params: string[] = [];

  if (filter?.processorId !== undefined) {
    clauses.push("runs.processor_id = ?");
    params.push(filter.processorId);
  }

  const where = clauses.length === 0 ? "" : ` AND ${clauses.join(" AND ")}`;
  const limitClause =
    filter?.limit !== undefined ? ` LIMIT ${Math.floor(filter.limit)}` : "";
  const sql = `${SELECT_PATCH_RECORDS_BASE_SQL}${where} ORDER BY capability_uses.recorded_at DESC, capability_uses.id DESC${limitClause}`;
  const rows = db.raw.query<PatchRecordRawRow, string[]>(sql).all(...params);
  return Object.freeze(rows.map(rowToPatchRecord));
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

function rowToPatchRecord(row: PatchRecordRawRow): PatchRecord {
  return Object.freeze({
    id: row.id,
    runId: row.run_id as RunId,
    processorId: row.processor_id,
    processorVersion: row.processor_version,
    phase: row.phase,
    status: row.status,
    capability: row.capability,
    resource: row.resource,
    outcome: narrowOutcome(row.outcome),
    inputCommit: row.input_commit,
    outputCommit: row.output_commit,
    effectHashes: Object.freeze(
      JSON.parse(row.effect_hashes_json) as ReadonlyArray<string>,
    ),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
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
