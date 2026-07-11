// answers-db: durable answers for QuestionEffect rows.
//
// Question rows in projection.db are rebuildable derived state. The human
// or agent/model decision attached to a question is not rebuildable from
// markdown, so this store keeps answers in a separate operational SQLite file
// that survives projection rebuilds.
//
// Open policy: MIGRATE, not REFUSE. Durable answer rows are unrebuildable, so
// an unknown schema-hash mismatch still refuses — but the one known prior
// hashes are upgraded in place by additive migrations. Pre-existing answers
// remain intact; rows without actor/evidence provenance conservatively retain
// `answered_by = 'owner'` and a null context.

import { Database } from "bun:sqlite";

import { err, ok, type Result } from "../types";
import { type SqliteTableShape } from "../sqlite-shape";
import { computeDdlHash } from "../sqlite/hash";
import { openSimpleStore, type StoreOpenError } from "../sqlite/open-store";

/** Schema hash of answers.db before the answered_by column (2026-06-27). A
 * store carrying exactly this hash is upgraded in place; any other mismatch
 * still refuses (durable answers are unrebuildable). */
export const ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY =
  "10b34ad0686bda70ca5325c3c9e71d6e32ea5ecef691f886952cfbcb648823b1";

/** Schema immediately before evidence-backed agent resolution. */
export const ANSWERS_SCHEMA_HASH_BEFORE_AGENT_CONTEXT =
  "8462c1eca18d2ebc8a0bbc1c6ff1ae29d1b713093ae0f10a0f0b8cfd1aafcd7b";

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
    + "answered_by TEXT NOT NULL DEFAULT 'owner',"
    + "answer_context_json TEXT,"
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
      "answered_by",
      "answer_context_json",
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
  readonly migration: "fresh" | "ok" | "migrated";
};

/** Answers refuse on mismatch; their open errors are exactly the shared seam's. */
export type AnswersDbError = StoreOpenError;

export async function openAnswersDb(
  opts: OpenAnswersDbOpts,
): Promise<Result<OpenAnswersDbResult, AnswersDbError>> {
  // Durable human/agent decisions are unrebuildable. Policy MIGRATE: the one
  // known prior hash (pre-answered_by) is upgraded in place via the additive
  // migration below; any other mismatch still refuses.
  const result = openSimpleStore({
    path: opts.path,
    metaTable: "answers_meta",
    ddl: DDL,
    currentHash: computeAnswersSchemaHash(),
    shapes: REQUIRED_TABLE_SHAPES,
    policy: {
      kind: "migrate",
      tryMigrate: (db, storedHash) => {
        if (
          storedHash !== ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY &&
          storedHash !== ANSWERS_SCHEMA_HASH_BEFORE_AGENT_CONTEXT
        ) return false;
        applyAnswerProvenanceMigration(db);
        return true;
      },
    },
  });
  if (!result.ok) return err(result.error);

  const { raw, schemaHash, migration } = result.value;
  const db: AnswersDb = Object.freeze({
    raw,
    schemaHash,
    close: () => raw.close(),
  });
  // openSimpleStore's SimpleMigration is exactly the answers enum.
  return ok(Object.freeze({ db, migration }));
}

export function computeAnswersSchemaHash(): string {
  return computeDdlHash(DDL);
}

// ----- internals ------------------------------------------------------------

function applyAnswerProvenanceMigration(db: Database): void {
  db.run("BEGIN");
  try {
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(question_answers)")
      .all();
    if (!cols.some((c) => c.name === "answered_by")) {
      db.run(
        "ALTER TABLE question_answers ADD COLUMN answered_by TEXT NOT NULL DEFAULT 'owner'",
      );
    }
    if (!cols.some((c) => c.name === "answer_context_json")) {
      db.run(
        "ALTER TABLE question_answers ADD COLUMN answer_context_json TEXT",
      );
    }
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}
