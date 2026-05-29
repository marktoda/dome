// answers-db: durable human answers for QuestionEffect rows.
//
// Question rows in projection.db are rebuildable derived state. The human
// decision attached to a question is not rebuildable from markdown, so this
// store keeps answers in a separate operational SQLite file that survives
// projection rebuilds.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

import { err, ok, type Result } from "../types";

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

const sha256 = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

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
    mkdirSync(parent, { recursive: true });
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
    applyDdl(raw);
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
  return sha256(DDL.join("\n"));
}

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

function insertOrReplaceMetaRow(db: Database, schemaHash: string): void {
  db.run("DELETE FROM answers_meta");
  db.query(
    "INSERT INTO answers_meta (schema_hash, built_at) VALUES (?, ?)",
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

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
