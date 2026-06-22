// ledger-db: the run-ledger store's connection lifecycle, schema definition,
// and schema-hash bookkeeping. This file is the SQLite boundary for the
// run-ledger layer, parallel to how `src/projections/db.ts` is the SQLite
// boundary for the projection layer and `src/outbox/db.ts` is the boundary
// for the outbox layer. The ledger lives in its OWN SQLite file
// (`<vault>/.dome/state/runs.db`) because — per the spec — the audit history
// of "what did Dome do" must not be wiped by a projection rebuild or by an
// outbox-schema migration (docs/wiki/specs/run-ledger.md §"File layout":
// "Separate SQLite file from `projection.db` so processor-run audit history
// is not wiped by a projection rebuild").
//
// Normative references:
//   - docs/wiki/specs/run-ledger.md §"Tables" §"Run lifecycle" §"File layout"
//     — the canonical schema + lifecycle + path location.
//   - docs/wiki/specs/vault-layout.md §"Derived operational state under
//     `.dome/`" — `runs.db` lives at `<vault>/.dome/state/runs.db`.
//
// Structural fences this file upholds:
//   - docs/wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED.md — every
//     `Processor.run()` invocation, regardless of phase or outcome, lands
//     one row in `runs`. This file owns the schema that makes that landing
//     site exist; `src/ledger/runs.ts` owns the per-row accessors.
//   - docs/wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS.md — the
//     ledger is the "audit surface" side of the dual surface. The `runs.id`
//     column joins to the `Dome-Run` trailer in engine commit messages.
//
// ============================================================================
// WARNING — schema mismatches are refused, never wiped.
// ============================================================================
//
// The ledger is the audit surface for "what did Dome do." Unlike
// `projection.db` (which is rebuildable from markdown + processors per
// [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]]) and unlike `outbox.db`
// (where the loss is bounded to in-flight external calls), the ledger
// is NOT rebuildable from any other surface. Wiping it on a schema-hash
// mismatch would erase:
//
//   - The history of every failed processor run (git only records
//     successful commits — failed runs leave NO trace outside the ledger).
//   - Every capability use ever recorded (audit forensics for "this
//     processor touched the dome.tasks namespace at this time").
//   - Every cost record (per-processor LLM spend tracking — the surface
//     `model.invoke.maxDailyCostUsd` enforcement queries).
//   - Wall-clock durations for performance debugging.
//
// Per docs/wiki/specs/run-ledger.md §"What the ledger cannot do":
// "corrupting the ledger requires rebuild from git trailers (lossy —
// capability uses and costs are unrecoverable for past runs)."
//
// V1 refuses unknown ledger schema mismatches. `openLedgerDb` returns
// `schema-mismatch` and closes the handle without mutating the file; `dome
// doctor` reports the mismatch through the operational health surface. A real
// schema-migration system (add-column, backfill, etc.) can be added later as
// explicit, audited migrations.
//
// If you find yourself adding a column to the ledger schema below, implement
// an explicit migration when existing rows can be safely backfilled. Otherwise
// the opener will refuse the old file and ask the operator to recover it
// explicitly.
// ============================================================================
//
// v1 Phase 5 scope:
//   - Schema migrations are intentionally refused unless implemented as an
//     explicit additive migration. The DDL uses `CREATE ... IF NOT EXISTS`
//     so a fresh open on a missing file is safe.
//
// Imports (tight by design — the ledger is the SQLite boundary):
//   - `bun:sqlite` for the `Database` handle (the only I/O dependency).
//   - `node:fs` / `node:path` for `mkdir -p` of the parent directory.
//   - `node:crypto` for sha256 (schema hash).
//   - `../types` for `Result<T, E>` and `ok`/`err` constructors.
//
// No imports from `src/engine/`, `src/processors/`, or `src/core/effect`.
// Per-run lifecycle accessors (insertQueued, markRunning, markSucceeded, ...)
// live in `src/ledger/runs.ts`; capability-use accessors live in
// `src/ledger/capability-uses.ts`.
//
// House-style notes (mirrors src/outbox/db.ts, src/projections/db.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - `Object.freeze` on returned handles and result objects so misbehaving
//     callers fail loudly at runtime rather than silently corrupting state.
//   - `noUncheckedIndexedAccess` discipline: SQLite `.all()` returns
//     arrays; index access and check `=== undefined` before reading.
//   - All errors surface via `Result.err`; the public function never
//     throws on expected failure paths (directory-create, DDL apply,
//     meta read). Programmer bugs can still throw — `Result` is for I/O
//     failures the caller can reasonably handle.

import { Database } from "bun:sqlite";

import { type Result, ok, err } from "../types";
import { type SqliteTableShape } from "../sqlite-shape";
import { computeDdlHash } from "../sqlite/hash";
import { openSimpleStore, type StoreOpenError } from "../sqlite/open-store";

// ----- Schema DDL -----------------------------------------------------------
//
// The canonical DDL. Order matters for schema-hash determinism — changing
// the order changes the hash, which is treated by `openLedgerDb` as a
// schema change. The hash is sha256 of the joined statements (joined by
// "\n"); see `computeLedgerSchemaHash` below.
//
// Statements are normalized to a single canonical form (no leading/trailing
// whitespace, single spaces between tokens). This protects the hash from
// trivial whitespace edits that don't change SQL semantics.

const DDL: ReadonlyArray<string> = Object.freeze([
  // 1. ledger_meta — the schema_hash + build timestamp.
  //    PRIMARY KEY (schema_hash) because the table holds at most one row;
  //    the schema_hash uniquely identifies the schema generation.
  "CREATE TABLE IF NOT EXISTS ledger_meta ("
    + "schema_hash TEXT NOT NULL PRIMARY KEY,"
    + "built_at TEXT NOT NULL"
    + ")",

  // 2. runs — one row per Processor.run() invocation. Per the spec:
  //    - `id` is the run id (format: `run_<unix-ms>_<6-char-rand>`).
  //    - `proposal_id` is nullable for view-phase / scheduled garden runs.
  //    - `output_commit` is nullable; set when the run contributed to a
  //      closure commit. The `Dome-Run` trailer on that commit equals
  //      `runs.id` (the dual-surface join key).
  //    - `effect_hashes_json` is the JSON-encoded string[] of sha256s for
  //      each emitted effect; never null (empty array `"[]"` is valid).
  //    - `cost_usd` is nullable; populated by `modelInvoke` wrapper.
  //    - `duration_ms` is null while the run is queued or running.
  //    - `error` is nullable; populated on failed runs only.
  //    - `trigger_kind` + `trigger_payload_json` capture what fired the run.
  //    - `started_at` is the queue-time timestamp; `finished_at` is set
  //      when the row reaches a terminal state.
  "CREATE TABLE IF NOT EXISTS runs ("
    + "id TEXT PRIMARY KEY,"
    + "proposal_id TEXT,"
    + "processor_id TEXT NOT NULL,"
    + "processor_version TEXT NOT NULL,"
    + "phase TEXT NOT NULL,"
    + "input_commit TEXT NOT NULL,"
    + "output_commit TEXT,"
    + "status TEXT NOT NULL,"
    + "effect_hashes_json TEXT NOT NULL,"
    + "cost_usd REAL,"
    + "duration_ms INTEGER,"
    + "error TEXT,"
    + "trigger_kind TEXT NOT NULL,"
    + "trigger_payload_json TEXT NOT NULL,"
    + "started_at TEXT NOT NULL,"
    + "finished_at TEXT"
    + ")",

  // 3. runs_by_proposal — supports "every run that contributed to proposal X"
  //    queries (the CLI's `dome inspect runs --proposal <id>`).
  //    Compound (proposal_id, started_at) so age-ordered queries within a
  //    proposal leverage the index ordering.
  "CREATE INDEX IF NOT EXISTS runs_by_proposal ON runs(proposal_id, started_at)",

  // 4. runs_by_processor — supports "every run of processor X" + the cost
  //    surface's "sum cost_usd grouped by processor since today" query.
  "CREATE INDEX IF NOT EXISTS runs_by_processor ON runs(processor_id, started_at)",

  // 5. runs_by_status — supports `dome inspect runs --status failed`,
  //    `--status running` (orphan detection), `--show orphan-runs`, etc.
  "CREATE INDEX IF NOT EXISTS runs_by_status ON runs(status, started_at)",

  // 6. capability_uses — one row per capability-attempt recorded by the
  //    broker or by runtime-only capability boundaries such as
  //    `model.invoke`. Per the spec §"Tables — capability_uses":
  //    - `run_id` REFERENCES runs(id). `openLedgerDb` enables
  //      `PRAGMA foreign_keys` so capability-use audit rows cannot orphan
  //      from their RunRecord.
  //    - `resource` is nullable; "the specific resource touched (path,
  //      namespace, etc.) or null".
  //    - `outcome` is the closed enum {"allowed", "downgraded", "denied"}.
  "CREATE TABLE IF NOT EXISTS capability_uses ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    + "run_id TEXT NOT NULL REFERENCES runs(id),"
    + "capability TEXT NOT NULL,"
    + "resource TEXT,"
    + "outcome TEXT NOT NULL,"
    + "recorded_at TEXT NOT NULL"
    + ")",

  // 7. capability_uses_by_run — supports "every capability use for run X"
  //    (the audit-forensics surface for a single run).
  "CREATE INDEX IF NOT EXISTS capability_uses_by_run ON capability_uses(run_id)",
]);

const REQUIRED_TABLE_SHAPES: ReadonlyArray<SqliteTableShape> = Object.freeze([
  {
    table: "ledger_meta",
    columns: ["schema_hash", "built_at"],
  },
  {
    table: "runs",
    columns: [
      "id",
      "proposal_id",
      "processor_id",
      "processor_version",
      "phase",
      "input_commit",
      "output_commit",
      "status",
      "effect_hashes_json",
      "cost_usd",
      "duration_ms",
      "error",
      "trigger_kind",
      "trigger_payload_json",
      "started_at",
      "finished_at",
    ],
  },
  {
    table: "capability_uses",
    columns: [
      "id",
      "run_id",
      "capability",
      "resource",
      "outcome",
      "recorded_at",
    ],
  },
]);

// ----- Public types ---------------------------------------------------------

/**
 * Opaque handle to the run-ledger database. The raw `Database` is exposed
 * because `src/ledger/runs.ts` and `src/ledger/capability-uses.ts` need it
 * to prepare statements; it is NOT for use outside the ledger layer — per
 * [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]] §"Structural
 * enforcement", only files under `src/ledger/` write to runs.db, and only
 * the engine (via those files) writes new rows.
 *
 * `schemaHash` is captured at open time. The schema is immutable for the
 * lifetime of the handle, so the value is safe to memoize.
 *
 * `close()` is idempotent per Bun's `sqlite3_close_v2` semantics.
 */
export type LedgerDb = {
  readonly raw: Database;
  readonly schemaHash: string;
  readonly close: () => void;
};

export type OpenLedgerDbOpts = {
  /**
   * Absolute filesystem path to the runs.db file. Caller computes
   * `<vault>/.dome/state/runs.db`; this file is vault-layout-agnostic
   * by design (separation of concerns: the ledger layer doesn't know
   * about `.dome/state/`).
   */
  readonly path: string;
};

/**
 * The three migration states the caller branches on:
 *
 * - `"fresh"`           — db file didn't exist (or was empty); schema
 *                         created; `ledger_meta` row inserted with the
 *                         current schema_hash.
 * - `"ok"`              — schema hash matches the stored value. No action
 *                         needed; existing runs + capability_uses rows
 *                         survive.
 */
export type LedgerMigration = "fresh" | "ok";

export type OpenLedgerDbResult = {
  readonly db: LedgerDb;
  readonly migration: LedgerMigration;
};

/** The ledger refuses on mismatch; its open errors are exactly the shared seam's. */
export type LedgerDbError = StoreOpenError;

// ----- Public hash helpers --------------------------------------------------

/**
 * sha256 of the canonical DDL string (statements joined by "\n"). Pure —
 * same DDL produces the same hash on every call. Exposed for testing and
 * for callers that want to log the schema version on startup.
 */
export function computeLedgerSchemaHash(): string {
  return computeDdlHash(DDL);
}

// ----- openLedgerDb ---------------------------------------------------------

/**
 * Open (or create) the run-ledger database at `opts.path`. Ensures the
 * parent directory exists, applies the schema if missing, and refuses
 * schema-hash mismatches without mutating the file.
 *
 * The function never throws on expected I/O failures — the conditions
 * (directory create, DDL apply, meta read) all surface as `Result.err`.
 * Programmer bugs (e.g., a logic error in this file) can still throw.
 *
 * Side effects on success:
 *   - Parent directory of `opts.path` exists.
 *   - SQLite file at `opts.path` exists with the canonical schema applied.
 *   - `ledger_meta` has exactly one row with `schema_hash` set to the
 *     current schema hash.
 */
export async function openLedgerDb(
  opts: OpenLedgerDbOpts,
): Promise<Result<OpenLedgerDbResult, LedgerDbError>> {
  // The ledger is unrebuildable audit history, so its policy is REFUSE on any
  // schema-hash mismatch (never wipe). `foreignKeys` is on for the
  // capability_uses → runs reference. The shared seam owns dir/open/hash/DDL/
  // shapes/meta/close-on-error.
  const result = openSimpleStore({
    path: opts.path,
    metaTable: "ledger_meta",
    ddl: DDL,
    currentHash: computeLedgerSchemaHash(),
    shapes: REQUIRED_TABLE_SHAPES,
    policy: { kind: "refuse" },
    foreignKeys: true,
  });
  if (!result.ok) return err(result.error);

  const { raw, schemaHash, migration } = result.value;
  // REFUSE policy never yields "migrated"; map onto the ledger's narrow enum.
  const ledgerMigration: LedgerMigration = migration === "fresh" ? "fresh" : "ok";

  const db: LedgerDb = Object.freeze({
    raw,
    schemaHash,
    close: () => raw.close(),
  });

  return ok(Object.freeze({ db, migration: ledgerMigration }));
}
