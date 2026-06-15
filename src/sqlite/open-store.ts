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

import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
