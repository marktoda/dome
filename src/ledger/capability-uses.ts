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

import { z } from "zod";

import { rowCodec } from "../sqlite/row-codec";
import { parseJsonColumn } from "../sqlite/row-json";
import { mapRows } from "../sqlite/rows";
import type { LedgerDb } from "./db";
import { limitClause } from "./limits";
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

const EffectHashesSchema = z.array(z.string().min(1));

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
  return mapRows(rows, rowToCapabilityUseRow);
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
  const sql = `${SELECT_PATCH_RECORDS_BASE_SQL}${where} ORDER BY capability_uses.recorded_at DESC, capability_uses.id DESC${limitClause(filter?.limit)}`;
  const rows = db.raw.query<PatchRecordRawRow, string[]>(sql).all(...params);
  return mapRows(rows, rowToPatchRecord);
}

// ----- internals ------------------------------------------------------------

const CAPABILITY_OUTCOMES = [
  "allowed",
  "downgraded",
  "denied",
] as const satisfies ReadonlyArray<CapabilityOutcome>;

// The DDL doesn't carry a CHECK constraint on `outcome` (v1 simplicity); the
// `enumCol` reader is the read-side fence. Two codecs because the patch-record
// query joins extra run columns onto the capability_use row.
const capUseCodec = rowCodec<CapabilityUseRawRow>("ledger.capability-uses");

const rowToCapabilityUseRow = capUseCodec.define<CapabilityUseRow>({
  id: capUseCodec.col("id"),
  runId: capUseCodec.brand("run_id", (v) => v as RunId),
  capability: capUseCodec.col("capability"),
  resource: capUseCodec.col("resource"),
  outcome: capUseCodec.enumCol("outcome", CAPABILITY_OUTCOMES),
  recordedAt: capUseCodec.col("recorded_at"),
});

const patchRecordCodec = rowCodec<PatchRecordRawRow>("ledger.capability-uses");

const rowToPatchRecord = patchRecordCodec.define<PatchRecord>({
  id: patchRecordCodec.col("id"),
  runId: patchRecordCodec.brand("run_id", (v) => v as RunId),
  processorId: patchRecordCodec.col("processor_id"),
  processorVersion: patchRecordCodec.col("processor_version"),
  // phase / status / commits are plain strings on PatchRecord (this is a
  // derived inspection view, not the narrowed RunRow), so they pass through.
  phase: patchRecordCodec.col("phase"),
  status: patchRecordCodec.col("status"),
  capability: patchRecordCodec.col("capability"),
  resource: patchRecordCodec.col("resource"),
  outcome: patchRecordCodec.enumCol("outcome", CAPABILITY_OUTCOMES),
  inputCommit: patchRecordCodec.col("input_commit"),
  outputCommit: patchRecordCodec.col("output_commit"),
  // `custom` with the source-table label: `effect_hashes_json` is JOINed from
  // the `runs` table, so the honest validation label is "runs.…", not this
  // accessor's table. (The auto-label `<table>.<col>` would misattribute it.)
  effectHashes: patchRecordCodec.custom((row) =>
    Object.freeze(
      parseJsonColumn(
        row.effect_hashes_json,
        "runs.effect_hashes_json",
        EffectHashesSchema,
      ),
    ),
  ),
  startedAt: patchRecordCodec.col("started_at"),
  finishedAt: patchRecordCodec.col("finished_at"),
  recordedAt: patchRecordCodec.col("recorded_at"),
});
