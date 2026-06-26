// sqlite/open-store: the genuinely-identical opener MECHANICS shared by the
// store db.ts files (projection.db, runs.db, outbox.db, answers.db). These are
// the byte-for-byte-identical building blocks ONLY — never the per-store
// durability POLICY (projections WIPE+rebuild; ledger/answers REFUSE; outbox
// ADDITIVE-MIGRATE). That branching stays in each store's opener, where the
// schema-mismatch tests pin it.
//
// What lives here:
//   - ensureParentDir(path)               — `mkdir -p` of the file's parent dir.
//   - applyDdlInTransaction(db, stmts)     — BEGIN → run each → COMMIT, ROLLBACK
//                                            on throw. (Was the private
//                                            `applyDdl` in every store, with the
//                                            module-level `DDL` lifted to a param
//                                            so it is store-agnostic. Projections
//                                            also use it for its DROP_DDL pass.)
//   - readStoredSchemaHash(db, metaTable)  — read the stored schema_hash from the
//                                            meta table, querying sqlite_master
//                                            first so a missing table returns
//                                            null instead of a noisy
//                                            SQLITE_ERROR. Shared by projections,
//                                            ledger, and outbox (whose private
//                                            copies were byte-identical modulo
//                                            the meta-table name). Answers keeps
//                                            its own `.get()`-based variant.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { type Result, ok, err } from "../types";
import { validateSqliteTableShapes, type SqliteTableShape } from "../sqlite-shape";
import { configureSqliteConnection } from "./connection";
import { errorMessage } from "./error-message";

/**
 * Ensure the parent directory of `path` exists. `recursive: true` is
 * `mkdir -p` semantics — no error if the directory already exists. Throws
 * (the caller wraps it in the store-specific `directory-create-failed`
 * Result.err) only on real I/O failure.
 */
export function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * Apply every statement in `statements` inside a single transaction.
 * Idempotent when the statements use `IF NOT EXISTS` (the schema-create case),
 * but the mechanic is statement-agnostic — projections also uses it for its
 * reverse-order DROP pass. Wrapped in a transaction so a mid-batch failure
 * leaves no half-applied schema (sqlite rolls back).
 */
export function applyDdlInTransaction(
  db: Database,
  statements: ReadonlyArray<string>,
): void {
  db.run("BEGIN");
  try {
    for (const stmt of statements) {
      db.run(stmt);
    }
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}

/**
 * Detect whether `metaTable` exists and, if so, return the stored
 * schema_hash. Returns `null` on either:
 *   - The table doesn't exist (fresh file).
 *   - The table exists but has zero rows (extremely-rare edge case where a
 *     prior open created the schema but crashed before inserting the row).
 *
 * The query against `sqlite_master` avoids a noisy SQLITE_ERROR that would
 * occur from SELECTing on a missing table. The meta-table name is the only
 * thing that differed between the projection/ledger/outbox copies, so it is a
 * parameter here.
 */
export function readStoredSchemaHash(
  db: Database,
  metaTable: string,
): string | null {
  const tableExists = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    )
    .all(metaTable);
  if (tableExists.length === 0) return null;

  const rows = db
    .query<{ schema_hash: string }, []>(
      `SELECT schema_hash FROM ${metaTable} LIMIT 1`,
    )
    .all();
  const first = rows[0];
  if (first === undefined) return null;
  return first.schema_hash;
}

// ============================================================================
// The shared store-opener seam.
// ============================================================================
//
// `prepareStore` is the universal PREFIX every store opens through: ensure-dir
// → open + configure (+ optional PRAGMA foreign_keys) → read stored hash →
// derive hash-only fresh/changed flags. It applies NO DDL, so a finish can
// refuse or DROP *before* the schema lands. On its own failures it closes the
// handle; on success the caller owns it.
//
// `openSimpleStore` is the shared FINISH for the three durable-log stores
// (ledger / outbox / answers): prepare → consult policy on schema change →
// apply DDL idempotently → validate shapes → write the single meta row
// (DELETE+INSERT in a tx — the robust superset that survives a hash change) →
// classify migration. It owns close-on-error for the whole tail. The projection
// CACHE keeps its own bespoke tail (WIPE / cache-key invalidation / 4-state) on
// top of `prepareStore`; that difference is essential (rebuildable cache vs.
// durable log), so it does not flow through `openSimpleStore`.
//
// See docs/superpowers/plans/2026-06-22-store-opener-deepening.md and
// docs/philosophy.md (depth as the test of a seam; locality > centralization).

/** Errors `prepareStore` (the prefix) can produce. */
export type PrepareStoreError =
  | {
      readonly kind: "directory-create-failed";
      readonly path: string;
      readonly cause: string;
    }
  | { readonly kind: "schema-init-failed"; readonly cause: string };

/** Errors a full simple-store open can produce: the prefix's, plus refusal. */
export type StoreOpenError =
  | PrepareStoreError
  | {
      readonly kind: "schema-mismatch";
      readonly stored: string;
      readonly expected: string;
    };

/** The prefix result: an open handle + the facts a finish needs to decide policy. */
export type Prepared = {
  readonly raw: Database;
  /** `null` when the file is fresh (no meta table, or table present but empty). */
  readonly storedHash: string | null;
  readonly currentHash: string;
  /** hash-only: `storedHash === null`. */
  readonly isFresh: boolean;
  /** hash-only: `storedHash !== null && storedHash !== currentHash`. */
  readonly isSchemaChanged: boolean;
};

export type PrepareStoreOpts = {
  readonly path: string;
  readonly metaTable: string;
  /** Caller computes via `computeDdlHash(DDL)`. */
  readonly currentHash: string;
  /** Enable `PRAGMA foreign_keys` (only the ledger needs it). Default off. */
  readonly foreignKeys?: boolean;
};

export function prepareStore(
  opts: PrepareStoreOpts,
): Result<Prepared, PrepareStoreError> {
  // 1. Ensure the parent directory exists (`mkdir -p` semantics).
  const parent = dirname(opts.path);
  try {
    ensureParentDir(opts.path);
  } catch (e) {
    return err({
      kind: "directory-create-failed",
      path: parent,
      cause: errorMessage(e),
    });
  }

  // 2. Open + configure the connection. Bun creates the file if missing.
  let raw: Database;
  try {
    raw = new Database(opts.path);
    configureSqliteConnection(raw);
    if (opts.foreignKeys === true) raw.run("PRAGMA foreign_keys = ON");
  } catch (e) {
    return err({ kind: "schema-init-failed", cause: errorMessage(e) });
  }

  // 3. Read the stored schema hash (null on a fresh file) and derive flags.
  let storedHash: string | null;
  try {
    storedHash = readStoredSchemaHash(raw, opts.metaTable);
  } catch (e) {
    raw.close();
    return err({ kind: "schema-init-failed", cause: errorMessage(e) });
  }

  const isFresh = storedHash === null;
  const isSchemaChanged = storedHash !== null && storedHash !== opts.currentHash;

  return ok({
    raw,
    storedHash,
    currentHash: opts.currentHash,
    isFresh,
    isSchemaChanged,
  });
}

/** Durability policy a durable-log store applies on a schema-hash mismatch. */
export type SimpleStorePolicy =
  | { readonly kind: "refuse" }
  | {
      readonly kind: "migrate";
      /** Returns true if it brought a known prior hash up to date, else false (→ refuse). */
      readonly tryMigrate: (db: Database, storedHash: string) => boolean;
    };

export type SimpleStoreSpec = {
  readonly path: string;
  readonly metaTable: string;
  readonly ddl: ReadonlyArray<string>;
  readonly currentHash: string;
  readonly shapes: ReadonlyArray<SqliteTableShape>;
  readonly policy: SimpleStorePolicy;
  readonly foreignKeys?: boolean;
};

export type SimpleMigration = "fresh" | "ok" | "migrated";

export type SimpleStoreResult = {
  /** The open handle; the caller wraps it into its own frozen, typed handle. */
  readonly raw: Database;
  readonly schemaHash: string;
  readonly migration: SimpleMigration;
};

export function openSimpleStore(
  spec: SimpleStoreSpec,
): Result<SimpleStoreResult, StoreOpenError> {
  const prepared = prepareStore({
    path: spec.path,
    metaTable: spec.metaTable,
    currentHash: spec.currentHash,
    foreignKeys: spec.foreignKeys ?? false,
  });
  if (!prepared.ok) return err(prepared.error); // PrepareStoreError ⊂ StoreOpenError

  const { raw, storedHash, currentHash, isFresh, isSchemaChanged } = prepared.value;

  let migrated = false;
  try {
    if (isSchemaChanged) {
      if (spec.policy.kind === "refuse") {
        raw.close();
        return err({
          kind: "schema-mismatch",
          stored: storedHash ?? "",
          expected: currentHash,
        });
      }
      // migrate: hand the store's tryMigrate the stored hash it keys on.
      const handled = spec.policy.tryMigrate(raw, storedHash ?? "");
      if (!handled) {
        raw.close();
        return err({
          kind: "schema-mismatch",
          stored: storedHash ?? "",
          expected: currentHash,
        });
      }
      migrated = true;
    }

    applyDdlInTransaction(raw, spec.ddl);
    const shapeError = validateSqliteTableShapes(raw, spec.shapes);
    if (shapeError !== null) throw new Error(shapeError);
    writeSingleMetaRow(raw, spec.metaTable, currentHash);
  } catch (e) {
    raw.close();
    return err({ kind: "schema-init-failed", cause: errorMessage(e) });
  }

  const migration: SimpleMigration = isFresh ? "fresh" : migrated ? "migrated" : "ok";
  return ok({ raw, schemaHash: currentHash, migration });
}

/**
 * Write the single meta row: `DELETE` then `INSERT` in one transaction. The
 * robust superset of the per-store mechanics this seam replaced — correct even
 * when the hash CHANGES (an additive migration leaves an orphan old-hash row
 * under `INSERT OR REPLACE`, since `schema_hash` is the primary key). Fresh:
 * the DELETE no-ops. Ok: same row, `built_at` refreshed. Migrated: old-hash row
 * removed, new row written.
 */
function writeSingleMetaRow(
  db: Database,
  metaTable: string,
  schemaHash: string,
): void {
  db.run("BEGIN");
  try {
    db.run(`DELETE FROM ${metaTable}`);
    db.run(`INSERT INTO ${metaTable} (schema_hash, built_at) VALUES (?, ?)`, [
      schemaHash,
      new Date().toISOString(),
    ]);
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}
