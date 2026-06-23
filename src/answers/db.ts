// answers-db: durable answers for QuestionEffect rows.
//
// Question rows in projection.db are rebuildable derived state. The human
// or agent/model decision attached to a question is not rebuildable from
// markdown, so this store keeps answers in a separate operational SQLite file
// that survives projection rebuilds.

import { Database } from "bun:sqlite";

import { err, ok, type Result } from "../types";
import { type SqliteTableShape } from "../sqlite-shape";
import { computeDdlHash } from "../sqlite/hash";
import { openSimpleStore, type StoreOpenError } from "../sqlite/open-store";

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

/** Answers refuse on mismatch; their open errors are exactly the shared seam's. */
export type AnswersDbError = StoreOpenError;

export async function openAnswersDb(
  opts: OpenAnswersDbOpts,
): Promise<Result<OpenAnswersDbResult, AnswersDbError>> {
  // Durable human/agent decisions are unrebuildable → policy REFUSE on mismatch.
  const result = openSimpleStore({
    path: opts.path,
    metaTable: "answers_meta",
    ddl: DDL,
    currentHash: computeAnswersSchemaHash(),
    shapes: REQUIRED_TABLE_SHAPES,
    policy: { kind: "refuse" },
  });
  if (!result.ok) return err(result.error);

  const { raw, schemaHash, migration } = result.value;
  const db: AnswersDb = Object.freeze({
    raw,
    schemaHash,
    close: () => raw.close(),
  });
  // REFUSE never yields "migrated"; map onto the narrow answers enum.
  const answersMigration: "fresh" | "ok" = migration === "fresh" ? "fresh" : "ok";
  return ok(Object.freeze({ db, migration: answersMigration }));
}

export function computeAnswersSchemaHash(): string {
  return computeDdlHash(DDL);
}
