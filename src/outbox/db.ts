// outbox-db: the outbox store's connection lifecycle, schema definition,
// and schema-hash bookkeeping. This file is the SQLite boundary for the
// outbox layer, parallel to how `src/projections/db.ts` is the SQLite
// boundary for the projection layer. The outbox lives in its OWN
// SQLite file (`<vault>/.dome/state/outbox.db`) because — per the spec —
// "outbox rows survive across vault re-opens, projection rebuilds, and
// engine restarts independently of the projection cache lifecycle"
// (docs/wiki/specs/projection-store.md §"Outbox").
//
// Normative references:
//   - docs/wiki/specs/projection-store.md §"Outbox (separate database:
//     outbox.db)" — the canonical schema + lifecycle.
//   - docs/wiki/specs/vault-layout.md §"Derived operational state under
//     `.dome/`" — `outbox.db` lives at `<vault>/.dome/state/outbox.db`.
//
// Structural fences this file upholds:
//   - docs/wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX.md — every
//     `ExternalActionEffect` lands in this database before the external
//     call is attempted. The schema is the structural enforcement: a
//     UNIQUE constraint on `idempotency_key` makes re-emission a no-op,
//     and the `status` column is the lifecycle state machine.
//
// Mitigated gotchas:
//   - docs/wiki/gotchas/outbox-stuck.md — terminally-failed rows are NOT
//     auto-pruned; the schema preserves them so `dome inspect outbox`
//     can list them and the user can replay or abandon. Pinned by the
//     "outbox is never silently discarded" rule in the gotcha file.
//
// ============================================================================
// WARNING — schema-mismatch wipe is a known data-loss event.
// ============================================================================
//
// Unlike `projection.db` (which is rebuildable from markdown + processors
// per [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]]), the outbox is NOT
// rebuildable. Deleting `outbox.db` — or wiping its tables on a schema-
// hash mismatch — loses every pending+failed external-action attempt.
// Sent rows are also lost, taking the audit history of "what did Dome
// call out to" with them.
//
// Phase 4 v1 still wipes on schema-hash mismatch because:
//   - The outbox schema is small and closed-set; the v1.x roadmap of
//     anticipated schema changes is minimal.
//   - A real schema-migration system (add-column, backfill, etc.) is
//     deferred to a post-v1 version with more substrate around it.
//   - The wipe is loud: the migration result `"schema-changed"` surfaces
//     to the caller so the engine can warn the user before continuing.
//
// If you find yourself adding a column to the outbox schema below, audit
// whether the wipe-on-mismatch behavior is acceptable for the change.
// For columns with default values that are safe to backfill, consider
// implementing an additive migration before bumping the schema hash.
// ============================================================================
//
// v1 Phase 4 scope:
//   - Schema migrations are the wipe (above). This file does not implement
//     incremental column-add migrations; it wipes and recreates on
//     schema-hash change. The DDL uses `CREATE ... IF NOT EXISTS` so a
//     fresh open on a missing file is safe.
//
// Imports (tight by design — outbox is the SQLite boundary):
//   - `bun:sqlite` for the `Database` handle (the only I/O dependency).
//   - `node:fs` / `node:path` for `mkdir -p` of the parent directory.
//   - `node:crypto` for sha256 (schema hash).
//   - `../types` for `Result<T, E>` and `ok`/`err` constructors.
//
// No imports from `src/engine/`, `src/processors/`, or `src/core/effect`.
// Effect serialization (ExternalActionEffect → row) lives in
// `src/outbox/dispatch.ts` (which imports `OutboxDb` from this file).
//
// House-style notes (mirrors src/projections/db.ts):
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
// the order changes the hash, which is treated by `openOutboxDb` as a
// schema change and triggers a wipe-and-recreate. The hash is sha256 of
// the joined statements (joined by "\n"); see `computeOutboxSchemaHash`
// below.
//
// Statements are normalized to a single canonical form (no leading/trailing
// whitespace, single spaces between tokens). This protects the hash from
// trivial whitespace edits that don't change SQL semantics.

const DDL: ReadonlyArray<string> = Object.freeze([
  // 1. outbox_meta — the schema_hash + build timestamp.
  //    PRIMARY KEY (schema_hash) because the table holds at most one row;
  //    the schema_hash uniquely identifies the schema generation.
  "CREATE TABLE IF NOT EXISTS outbox_meta ("
    + "schema_hash TEXT NOT NULL,"
    + "built_at TEXT NOT NULL,"
    + "PRIMARY KEY (schema_hash)"
    + ")",

  // 2. outbox — ExternalActionEffect rows. UNIQUE (idempotency_key) makes
  //    re-emission a silent no-op via INSERT OR IGNORE — pinned by
  //    [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]] §"Idempotency".
  //
  //    Nullable columns:
  //      external_id — set on success (the remote system's id).
  //      sent_at     — set on success.
  //      last_error  — set on the most recent failed attempt.
  "CREATE TABLE IF NOT EXISTS outbox ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    + "capability TEXT NOT NULL,"
    + "idempotency_key TEXT NOT NULL UNIQUE,"
    + "payload_json TEXT NOT NULL,"
    + "source_refs TEXT NOT NULL,"
    + "status TEXT NOT NULL,"
    + "external_id TEXT,"
    + "attempts INTEGER NOT NULL DEFAULT 0,"
    + "max_attempts INTEGER NOT NULL DEFAULT 3,"
    + "enqueued_at TEXT NOT NULL,"
    + "sent_at TEXT,"
    + "last_error TEXT,"
    + "run_id TEXT NOT NULL"
    + ")",

  // 3. outbox_by_status — supports `dome inspect outbox` queries
  //    filtered by status (e.g., "all failed", "all pending older than 24h").
  //    Compound (status, enqueued_at) so age-filtered queries can leverage
  //    the index ordering.
  "CREATE INDEX IF NOT EXISTS outbox_by_status ON outbox(status, enqueued_at)",
]);

// Drop order: reverse-creation. `outbox_meta` is dropped last so the
// schema-version row remains queryable as long as possible during a wipe
// (defense in depth).
const DROP_DDL: ReadonlyArray<string> = Object.freeze([
  "DROP INDEX IF EXISTS outbox_by_status",
  "DROP TABLE IF EXISTS outbox",
  "DROP TABLE IF EXISTS outbox_meta",
]);

// ----- sha256 helper --------------------------------------------------------

const sha256 = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

// ----- Public types ---------------------------------------------------------

/**
 * Opaque handle to the outbox database. The raw `Database` is exposed
 * because `src/outbox/dispatch.ts` needs it to prepare statements; it is
 * NOT for use outside the outbox layer — per
 * [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]] §"Structural
 * enforcement", only files under `src/outbox/` write to outbox.db.
 *
 * `schemaHash` is captured at open time. The schema is immutable for the
 * lifetime of the handle (the wipe-and-recreate path happens before the
 * handle is returned), so the value is safe to memoize.
 *
 * `close()` is idempotent per Bun's `sqlite3_close_v2` semantics.
 */
export type OutboxDb = {
  readonly raw: Database;
  readonly schemaHash: string;
  readonly close: () => void;
};

export type OpenOutboxDbOpts = {
  /**
   * Absolute filesystem path to the outbox.db file. Caller computes
   * `<vault>/.dome/state/outbox.db`; this file is vault-layout-agnostic
   * by design (separation of concerns: the outbox layer doesn't know
   * about `.dome/state/`).
   */
  readonly path: string;
};

/**
 * The three migration states the caller branches on:
 *
 * - `"fresh"`           — db file didn't exist (or was empty); schema
 *                         created; `outbox_meta` row inserted with the
 *                         current schema_hash.
 * - `"ok"`              — schema hash matches the stored value. No action
 *                         needed; pending+failed rows survive.
 * - `"schema-changed"`  — schema hash differs from the stored value.
 *                         Tables wiped and recreated; meta row reset.
 *                         **This is a data-loss event** (see file banner).
 */
export type OutboxMigration = "fresh" | "ok" | "schema-changed";

export type OpenOutboxDbResult = {
  readonly db: OutboxDb;
  readonly migration: OutboxMigration;
};

export type OutboxDbError =
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
export function computeOutboxSchemaHash(): string {
  return sha256(DDL.join("\n"));
}

// ----- openOutboxDb ---------------------------------------------------------

/**
 * Open (or create) the outbox database at `opts.path`. Ensures the parent
 * directory exists, applies the schema if missing, and detects schema-hash
 * mismatch (wiping and recreating if so — see file banner warning).
 *
 * The function never throws on expected I/O failures — the conditions
 * (directory create, DDL apply, meta read) all surface as `Result.err`.
 * Programmer bugs (e.g., a logic error in this file) can still throw.
 *
 * Side effects on success:
 *   - Parent directory of `opts.path` exists.
 *   - SQLite file at `opts.path` exists with the canonical schema applied.
 *   - `outbox_meta` has exactly one row with `schema_hash` set to the
 *     current schema hash.
 */
export async function openOutboxDb(
  opts: OpenOutboxDbOpts,
): Promise<Result<OpenOutboxDbResult, OutboxDbError>> {
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
  //    outbox_meta table; we detect that by querying sqlite_master.
  const currentSchemaHash = computeOutboxSchemaHash();
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

  // 5. Ensure exactly one outbox_meta row exists with the current schema
  //    hash. On fresh/schema-changed paths, the row is missing (the wipe
  //    dropped the table; the CREATE re-created it empty). On the "ok"
  //    path, the existing row's hash already matches; INSERT OR REPLACE
  //    is a defensive no-op (same hash → same row).
  try {
    insertOrReplaceMetaRow(raw, currentSchemaHash);
  } catch (e) {
    raw.close();
    return err({ kind: "schema-init-failed", cause: errorMessage(e) });
  }

  // 6. Compute the migration state.
  let migration: OutboxMigration;
  if (isFresh) {
    migration = "fresh";
  } else if (isSchemaChanged) {
    migration = "schema-changed";
  } else {
    migration = "ok";
  }

  const db: OutboxDb = Object.freeze({
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
 * before re-applying the current DDL. **Data-loss event** — see file
 * banner. Wrapped in a transaction for the same reason as `applyDdl`.
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
 * Detect whether `outbox_meta` exists and, if so, return the stored
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
      "SELECT name FROM sqlite_master WHERE type='table' AND name='outbox_meta'",
    )
    .all();
  if (tableExists.length === 0) return null;

  const rows = db
    .query<{ schema_hash: string }, []>(
      "SELECT schema_hash FROM outbox_meta LIMIT 1",
    )
    .all();
  const first = rows[0];
  if (first === undefined) return null;
  return first.schema_hash;
}

/**
 * Insert (or replace) the single `outbox_meta` row with the given
 * schema_hash and the current timestamp. `INSERT OR REPLACE` because the
 * PRIMARY KEY is `schema_hash` — if a row with this hash already exists
 * (the "ok" path), we overwrite the `built_at` timestamp (cheap, makes
 * "when was the schema last verified" observable) rather than fail.
 */
function insertOrReplaceMetaRow(db: Database, schemaHash: string): void {
  db.run(
    "INSERT OR REPLACE INTO outbox_meta (schema_hash, built_at) VALUES (?, ?)",
    [schemaHash, new Date().toISOString()],
  );
}
