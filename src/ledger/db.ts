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
// WARNING — schema-mismatch wipe is a known, severe data-loss event.
// ============================================================================
//
// The ledger is the audit surface for "what did Dome do." Unlike
// `projection.db` (which is rebuildable from markdown + processors per
// [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]]) and unlike `outbox.db`
// (where the loss is bounded to in-flight external calls), the ledger
// is NOT rebuildable from any other surface. Wiping it on a schema-hash
// mismatch erases:
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
// Phase 5 v1 still wipes on schema-hash mismatch because:
//   - The ledger schema is small and closed-set; the v1.x roadmap of
//     anticipated schema changes is minimal.
//   - A real schema-migration system (add-column, backfill, etc.) is
//     deferred to a post-v1 version with more substrate around it.
//   - The wipe is loud: the migration result `"schema-changed"` surfaces
//     to the caller so the engine can warn the user before continuing
//     (`dome doctor --show runs` going from N rows to zero is the
//     loudest possible failure mode).
//
// If you find yourself adding a column to the ledger schema below, audit
// whether the wipe-on-mismatch behavior is acceptable for the change.
// For columns with default values that are safe to backfill, consider
// implementing an additive migration before bumping the schema hash.
// ============================================================================
//
// v1 Phase 5 scope:
//   - Schema migrations are the wipe (above). This file does not implement
//     incremental column-add migrations; it wipes and recreates on
//     schema-hash change. The DDL uses `CREATE ... IF NOT EXISTS` so a
//     fresh open on a missing file is safe.
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
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

import { type Result, ok, err } from "../types";

// ----- Schema DDL -----------------------------------------------------------
//
// The canonical DDL. Order matters for schema-hash determinism — changing
// the order changes the hash, which is treated by `openLedgerDb` as a
// schema change and triggers a wipe-and-recreate. The hash is sha256 of
// the joined statements (joined by "\n"); see `computeLedgerSchemaHash`
// below.
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
  //    - `proposal_id` is nullable for view-phase / scheduled-cron-only runs.
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
  //    queries (the CLI's `dome doctor --show runs --proposal <id>`).
  //    Compound (proposal_id, started_at) so age-ordered queries within a
  //    proposal leverage the index ordering.
  "CREATE INDEX IF NOT EXISTS runs_by_proposal ON runs(proposal_id, started_at)",

  // 4. runs_by_processor — supports "every run of processor X" + the cost
  //    surface's "sum cost_usd grouped by processor since today" query.
  "CREATE INDEX IF NOT EXISTS runs_by_processor ON runs(processor_id, started_at)",

  // 5. runs_by_status — supports `dome doctor --show runs --status failed`,
  //    `--status running` (orphan detection), `--show orphan-runs`, etc.
  "CREATE INDEX IF NOT EXISTS runs_by_status ON runs(status, started_at)",

  // 6. capability_uses — one row per capability-attempt recorded by the
  //    broker. Per the spec §"Tables — capability_uses":
  //    - `run_id` REFERENCES runs(id). Foreign-key enforcement is not
  //      enabled in v1 (PRAGMA foreign_keys defaults to off in SQLite);
  //      the schema documents the relationship for human readers and for
  //      a future tightening pass.
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

// Drop order: reverse-creation. `ledger_meta` is dropped last so the
// schema-version row remains queryable as long as possible during a wipe
// (defense in depth).
const DROP_DDL: ReadonlyArray<string> = Object.freeze([
  "DROP INDEX IF EXISTS capability_uses_by_run",
  "DROP TABLE IF EXISTS capability_uses",
  "DROP INDEX IF EXISTS runs_by_status",
  "DROP INDEX IF EXISTS runs_by_processor",
  "DROP INDEX IF EXISTS runs_by_proposal",
  "DROP TABLE IF EXISTS runs",
  "DROP TABLE IF EXISTS ledger_meta",
]);

// ----- sha256 helper --------------------------------------------------------

const sha256 = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

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
 * lifetime of the handle (the wipe-and-recreate path happens before the
 * handle is returned), so the value is safe to memoize.
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
 * - `"schema-changed"`  — schema hash differs from the stored value.
 *                         Tables wiped and recreated; meta row reset.
 *                         **This is a severe data-loss event** — see the
 *                         file banner. The caller should surface a warning
 *                         to the user before continuing.
 */
export type LedgerMigration = "fresh" | "ok" | "schema-changed";

export type OpenLedgerDbResult = {
  readonly db: LedgerDb;
  readonly migration: LedgerMigration;
};

export type LedgerDbError =
  | {
      readonly kind: "directory-create-failed";
      readonly path: string;
      readonly cause: string;
    }
  | {
      readonly kind: "schema-init-failed";
      readonly cause: string;
    };

// ----- Public hash helpers --------------------------------------------------

/**
 * sha256 of the canonical DDL string (statements joined by "\n"). Pure —
 * same DDL produces the same hash on every call. Exposed for testing and
 * for callers that want to log the schema version on startup.
 */
export function computeLedgerSchemaHash(): string {
  return sha256(DDL.join("\n"));
}

// ----- openLedgerDb ---------------------------------------------------------

/**
 * Open (or create) the run-ledger database at `opts.path`. Ensures the
 * parent directory exists, applies the schema if missing, and detects
 * schema-hash mismatch (wiping and recreating if so — see file banner
 * warning).
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
  // 1. Ensure the parent directory exists. `recursive: true` is mkdir -p
  //    semantics — no error if the directory already exists.
  const parent = dirname(opts.path);
  try {
    mkdirSync(parent, { recursive: true });
  } catch (e) {
    return err({
      kind: "directory-create-failed",
      path: parent,
      cause: errorMessage(e),
    });
  }

  // 2. Open the SQLite file. Bun's Database constructor creates the file
  //    if it doesn't exist (default options: `{readwrite: true, create: true}`).
  let raw: Database;
  try {
    raw = new Database(opts.path);
  } catch (e) {
    return err({ kind: "schema-init-failed", cause: errorMessage(e) });
  }

  // 3. Read the stored schema_hash, if any. A fresh file has no
  //    ledger_meta table; we detect that by querying sqlite_master.
  const currentSchemaHash = computeLedgerSchemaHash();
  let storedSchemaHash: string | null;
  try {
    storedSchemaHash = readStoredSchemaHash(raw);
  } catch (e) {
    raw.close();
    return err({ kind: "schema-init-failed", cause: errorMessage(e) });
  }

  const isFresh = storedSchemaHash === null;
  const isSchemaChanged =
    storedSchemaHash !== null && storedSchemaHash !== currentSchemaHash;

  // 4. If schema changed, wipe everything (data-loss event — see banner);
  //    if fresh, just apply DDL; if matched, apply DDL idempotently
  //    (`CREATE ... IF NOT EXISTS` is safe and defensive against a partial
  //    schema left by a prior crash).
  try {
    if (isSchemaChanged) {
      applyDropAll(raw);
    }
    applyDdl(raw);
  } catch (e) {
    raw.close();
    return err({ kind: "schema-init-failed", cause: errorMessage(e) });
  }

  // 5. Ensure exactly one ledger_meta row exists with the current schema
  //    hash. On fresh/schema-changed paths, the row is missing (the wipe
  //    dropped the table; the CREATE re-created it empty). On the "ok"
  //    path, the existing row's hash already matches; INSERT OR REPLACE
  //    is a defensive no-op (same hash → same row, updated built_at).
  try {
    insertOrReplaceMetaRow(raw, currentSchemaHash);
  } catch (e) {
    raw.close();
    return err({ kind: "schema-init-failed", cause: errorMessage(e) });
  }

  // 6. Compute the migration state.
  let migration: LedgerMigration;
  if (isFresh) {
    migration = "fresh";
  } else if (isSchemaChanged) {
    migration = "schema-changed";
  } else {
    migration = "ok";
  }

  const db: LedgerDb = Object.freeze({
    raw,
    schemaHash: currentSchemaHash,
    close: () => raw.close(),
  });

  return ok(Object.freeze({ db, migration }));
}

// ----- internals ------------------------------------------------------------

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * Apply every CREATE statement in `DDL`. Idempotent — every statement
 * uses `IF NOT EXISTS`, so re-applying on an already-populated database
 * is a no-op. Wrapped in a transaction so a mid-DDL failure leaves no
 * half-created tables (sqlite rolls back).
 */
function applyDdl(db: Database): void {
  db.run("BEGIN");
  try {
    for (const stmt of DDL) {
      db.run(stmt);
    }
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}

/**
 * Drop every table + index per `DROP_DDL`. Used on schema-hash mismatch
 * before re-applying the current DDL. **Severe data-loss event** — see
 * file banner. Wrapped in a transaction for the same reason as `applyDdl`.
 */
function applyDropAll(db: Database): void {
  db.run("BEGIN");
  try {
    for (const stmt of DROP_DDL) {
      db.run(stmt);
    }
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}

/**
 * Detect whether `ledger_meta` exists and, if so, return the stored
 * schema_hash. Returns `null` on either:
 *   - The table doesn't exist (fresh file).
 *   - The table exists but has zero rows (extremely-rare edge case where
 *     a prior open created the schema but crashed before inserting the row).
 *
 * The query against `sqlite_master` avoids a noisy SQLITE_ERROR that
 * would occur from SELECTing on a missing table.
 */
function readStoredSchemaHash(db: Database): string | null {
  const tableExists = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_meta'",
    )
    .all();
  if (tableExists.length === 0) return null;

  const rows = db
    .query<{ schema_hash: string }, []>(
      "SELECT schema_hash FROM ledger_meta LIMIT 1",
    )
    .all();
  const first = rows[0];
  if (first === undefined) return null;
  return first.schema_hash;
}

/**
 * Insert (or replace) the single `ledger_meta` row with the given
 * schema_hash and the current timestamp. `INSERT OR REPLACE` because the
 * PRIMARY KEY is `schema_hash` — if a row with this hash already exists
 * (the "ok" path), we overwrite the `built_at` timestamp (cheap, makes
 * "when was the schema last verified" observable) rather than fail.
 */
function insertOrReplaceMetaRow(db: Database, schemaHash: string): void {
  db.run(
    "INSERT OR REPLACE INTO ledger_meta (schema_hash, built_at) VALUES (?, ?)",
    [schemaHash, new Date().toISOString()],
  );
}
