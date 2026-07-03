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
// WARNING — unknown schema mismatches are refused, never wiped.
// ============================================================================
//
// Unlike `projection.db` (which is rebuildable from markdown + processors
// per [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]]), the outbox is NOT
// rebuildable. Deleting `outbox.db` — or wiping its tables on a schema-
// hash mismatch — would lose every pending+failed external-action attempt.
// Sent rows would also be lost, taking the audit history of "what did Dome
// call out to" with them.
//
// Phase 4 v1 supports a small allowlist of additive migrations for columns
// that are safe to backfill. Unknown schema-hash mismatches return
// `schema-mismatch` and close the handle without mutating the file. `dome
// doctor` reports the mismatch through the operational health surface.
//
// If you find yourself adding a column to the outbox schema below, implement
// an additive migration when existing rows can be safely backfilled. Otherwise
// the opener will refuse the old file and ask the operator to recover it
// explicitly.
// ============================================================================
//
// v1 Phase 4 scope:
//   - Schema migrations are intentionally small and explicit. Known
//     additive changes are allowlisted below; unknown schema changes are
//     refused. The DDL uses `CREATE ... IF NOT EXISTS` so a fresh open on a
//     missing file is safe.
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

import { type Result, ok, err } from "../types";
import { type SqliteTableShape } from "../sqlite-shape";
import { computeDdlHash } from "../sqlite/hash";
import { openSimpleStore, type StoreOpenError } from "../sqlite/open-store";

/** Schema hash of outbox.db before the `next_attempt_at` column. A store
 * carrying exactly this hash is upgraded in place; any other mismatch still
 * refuses (the outbox is unrebuildable — see the file-header WARNING). */
export const OUTBOX_SCHEMA_HASH_BEFORE_NEXT_ATTEMPT_AT =
  "82000d3d8dd8578f9c34d23fcca621c085aaf78d5d228ee62df824b739f19a68";
const OUTBOX_EPOCH_ISO = "1970-01-01T00:00:00.000Z";

// ----- Schema DDL -----------------------------------------------------------
//
// The canonical DDL. Order matters for schema-hash determinism — changing
// the order changes the hash, which is treated by `openOutboxDb` as a
// schema change. The hash is sha256 of the joined statements (joined by
// "\n"); see `computeOutboxSchemaHash` below.
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
    + `next_attempt_at TEXT NOT NULL DEFAULT '${OUTBOX_EPOCH_ISO}',`
    + "sent_at TEXT,"
    + "last_error TEXT,"
    + "run_id TEXT NOT NULL"
    + ")",

  // 3. outbox_by_status — supports `dome inspect outbox` queries
  //    filtered by status (e.g., "all failed", "all pending older than 24h").
  //    Compound (status, enqueued_at) so age-filtered queries can leverage
  //    the index ordering.
  "CREATE INDEX IF NOT EXISTS outbox_by_status ON outbox(status, enqueued_at)",
  "CREATE INDEX IF NOT EXISTS outbox_by_due ON outbox(status, next_attempt_at, enqueued_at)",
]);

const REQUIRED_TABLE_SHAPES: ReadonlyArray<SqliteTableShape> = Object.freeze([
  {
    table: "outbox_meta",
    columns: ["schema_hash", "built_at"],
  },
  {
    table: "outbox",
    columns: [
      "id",
      "capability",
      "idempotency_key",
      "payload_json",
      "source_refs",
      "status",
      "external_id",
      "attempts",
      "max_attempts",
      "enqueued_at",
      "next_attempt_at",
      "sent_at",
      "last_error",
      "run_id",
    ],
  },
]);

// ----- Public types ---------------------------------------------------------

/**
 * Opaque handle to the outbox database. The raw `Database` is exposed
 * because `src/outbox/dispatch.ts` needs it to prepare statements; it is
 * NOT for use outside the outbox layer — per
 * [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]] §"Structural
 * enforcement", only files under `src/outbox/` write to outbox.db.
 *
 * `schemaHash` is captured at open time. The schema is immutable for the
 * lifetime of the handle, so the value is safe to memoize.
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
 * - `"migrated"`        — schema hash differed, but a known additive
 *                         migration preserved existing rows.
 */
export type OutboxMigration = "fresh" | "ok" | "migrated";

export type OpenOutboxDbResult = {
  readonly db: OutboxDb;
  readonly migration: OutboxMigration;
};

/** Outbox migrates a known prior hash, else refuses; its errors are the seam's. */
export type OutboxDbError = StoreOpenError;

// ----- Public hash helpers --------------------------------------------------

/**
 * sha256 of the canonical DDL string (statements joined by "\n"). Pure —
 * same DDL produces the same hash on every call. Exposed for testing and
 * for callers that want to log the schema version on startup.
 */
export function computeOutboxSchemaHash(): string {
  return computeDdlHash(DDL);
}

// ----- openOutboxDb ---------------------------------------------------------

/**
 * Open (or create) the outbox database at `opts.path`. Ensures the parent
 * directory exists, applies the schema if missing, and detects schema-hash
 * mismatch. Unknown mismatches return `schema-mismatch` without mutating the
 * file; known additive migrations may preserve and upgrade existing rows.
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
  // Outbox holds unrebuildable in-flight external-call rows. Policy MIGRATE:
  // a known prior hash (pre-next_attempt_at) is upgraded in place via the
  // idempotent additive migration; any other mismatch refuses. The shared seam
  // owns dir/open/hash/DDL/shapes/meta (DELETE+INSERT)/close-on-error.
  const result = openSimpleStore({
    path: opts.path,
    metaTable: "outbox_meta",
    ddl: DDL,
    currentHash: computeOutboxSchemaHash(),
    shapes: REQUIRED_TABLE_SHAPES,
    policy: {
      kind: "migrate",
      tryMigrate: (db, storedHash) => {
        if (storedHash !== OUTBOX_SCHEMA_HASH_BEFORE_NEXT_ATTEMPT_AT) return false;
        applyNextAttemptAtMigration(db);
        return true;
      },
    },
  });
  if (!result.ok) return err(result.error);

  const { raw, schemaHash, migration } = result.value;
  const db: OutboxDb = Object.freeze({
    raw,
    schemaHash,
    close: () => raw.close(),
  });

  // openSimpleStore's SimpleMigration is exactly OutboxMigration.
  return ok(Object.freeze({ db, migration: migration satisfies OutboxMigration }));
}

// ----- internals ------------------------------------------------------------

function applyNextAttemptAtMigration(db: Database): void {
  db.run("BEGIN");
  try {
    if (!outboxColumnExists(db, "next_attempt_at")) {
      db.run(
        `ALTER TABLE outbox ADD COLUMN next_attempt_at TEXT NOT NULL DEFAULT '${OUTBOX_EPOCH_ISO}'`,
      );
    }
    db.run(
      `UPDATE outbox SET next_attempt_at = enqueued_at WHERE next_attempt_at = '${OUTBOX_EPOCH_ISO}'`,
    );
    db.run(
      "CREATE INDEX IF NOT EXISTS outbox_by_due ON outbox(status, next_attempt_at, enqueued_at)",
    );
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}

function outboxColumnExists(db: Database, columnName: string): boolean {
  const rows = db
    .query<{ name: string }, []>("PRAGMA table_info(outbox)")
    .all();
  return rows.some((row) => row.name === columnName);
}
