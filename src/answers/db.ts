// answers-db: durable answers for QuestionEffect rows.
//
// Question rows in projection.db are rebuildable derived state. The human
// or agent/model decision attached to a question is not rebuildable from
// markdown, so this store keeps answers in a separate operational SQLite file
// that survives projection rebuilds.

import { Database } from "bun:sqlite";
import { dirname } from "node:path";

import { err, ok, type Result } from "../types";
import {
  validateSqliteTableShapes,
  type SqliteTableShape,
} from "../sqlite-shape";
import { configureSqliteConnection } from "../sqlite/connection";
import { errorMessage } from "../sqlite/error-message";
import { computeDdlHash } from "../sqlite/hash";
import { applyDdlInTransaction, ensureParentDir } from "../sqlite/open-store";

const DDL: ReadonlyArray<string> = Object.freeze([
  "CREATE TABLE IF NOT EXISTS answers_meta ("
    + "schema_hash TEXT NOT NULL PRIMARY KEY,"
    + "built_at TEXT NOT NULL"
    + ")",
  "CREATE TABLE IF NOT EXISTS question_answers ("
    + "idempotency_key TEXT PRIMARY KEY,"
    + "answer TEXT NOT NULL,"
    + "answered_at TEXT NOT NULL,"
    + "question_id INTEGER,"
    + "question TEXT NOT NULL,"
    + "processor_id TEXT NOT NULL,"
    + "adopted_commit TEXT NOT NULL,"
    + "handler_status TEXT NOT NULL DEFAULT 'pending',"
    + "handler_attempts INTEGER NOT NULL DEFAULT 0,"
    + "last_handler_attempt_at TEXT,"
    + "handled_at TEXT,"
    + "last_handler_error TEXT"
    + ")",
  "CREATE INDEX IF NOT EXISTS question_answers_by_answered_at "
    + "ON question_answers(answered_at)",
  "CREATE INDEX IF NOT EXISTS question_answers_by_handler_status "
    + "ON question_answers(handler_status, answered_at)",
]);

const REQUIRED_TABLE_SHAPES: ReadonlyArray<SqliteTableShape> = Object.freeze([
  {
    table: "answers_meta",
    columns: ["schema_hash", "built_at"],
  },
  {
    table: "question_answers",
    columns: [
      "idempotency_key",
      "answer",
      "answered_at",
      "question_id",
      "question",
      "processor_id",
      "adopted_commit",
      "handler_status",
      "handler_attempts",
      "last_handler_attempt_at",
      "handled_at",
      "last_handler_error",
    ],
  },
]);

export type AnswersDb = {
  readonly raw: Database;
  readonly schemaHash: string;
  readonly close: () => void;
};

export type OpenAnswersDbOpts = {
  readonly path: string;
};

export type OpenAnswersDbResult = {
  readonly db: AnswersDb;
  readonly migration: "fresh" | "ok";
};

export type AnswersDbError =
  | {
      readonly kind: "directory-create-failed";
      readonly path: string;
      readonly cause: string;
    }
  | {
      readonly kind: "schema-init-failed";
      readonly cause: string;
    }
  | {
      readonly kind: "schema-mismatch";
      readonly stored: string;
      readonly expected: string;
    };

export async function openAnswersDb(
  opts: OpenAnswersDbOpts,
): Promise<Result<OpenAnswersDbResult, AnswersDbError>> {
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

  let raw: Database;
  try {
    raw = new Database(opts.path);
    configureSqliteConnection(raw);
  } catch (e) {
    return err({ kind: "schema-init-failed", cause: errorMessage(e) });
  }

  const schemaHash = computeAnswersSchemaHash();
  let storedSchemaHash: string | null;
  try {
    storedSchemaHash = readStoredSchemaHash(raw);
    if (storedSchemaHash !== null && storedSchemaHash !== schemaHash) {
      raw.close();
      return err({
        kind: "schema-mismatch",
        stored: storedSchemaHash,
        expected: schemaHash,
      });
    }
    applyDdlInTransaction(raw, DDL);
    const shapeError = validateSqliteTableShapes(raw, REQUIRED_TABLE_SHAPES);
    if (shapeError !== null) {
      throw new Error(shapeError);
    }
    insertOrReplaceMetaRow(raw, schemaHash);
  } catch (e) {
    raw.close();
    return err({ kind: "schema-init-failed", cause: errorMessage(e) });
  }

  const db: AnswersDb = Object.freeze({
    raw,
    schemaHash,
    close: () => raw.close(),
  });
  const migration = storedSchemaHash === null ? "fresh" : "ok";
  return ok(Object.freeze({ db, migration }));
}

export function computeAnswersSchemaHash(): string {
  return computeDdlHash(DDL);
}

function insertOrReplaceMetaRow(db: Database, schemaHash: string): void {
  db.query(
    "INSERT INTO answers_meta (schema_hash, built_at) VALUES (?, ?) "
      + "ON CONFLICT(schema_hash) DO UPDATE SET built_at = excluded.built_at",
  ).run(schemaHash, new Date().toISOString());
}

function readStoredSchemaHash(db: Database): string | null {
  const hasMeta = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get("answers_meta");
  if (hasMeta === null) return null;
  const row = db
    .query<{ schema_hash: string }, []>(
      "SELECT schema_hash FROM answers_meta LIMIT 1",
    )
    .get();
  return row?.schema_hash ?? null;
}
