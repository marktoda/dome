// request-receipts/db: durable, device-attributed operation audit storage.
// This file owns only schema/open lifecycle; state transitions live in
// request-receipts.ts. Unknown schema changes refuse rather than erase audit.

import { Database } from "bun:sqlite";

import { type SqliteTableShape } from "../sqlite-shape";
import { computeDdlHash } from "../sqlite/hash";
import { openSimpleStore, type StoreOpenError } from "../sqlite/open-store";
import { errorMessage } from "../sqlite/error-message";
import { err, ok, type Result } from "../types";

const DDL: ReadonlyArray<string> = Object.freeze([
  "CREATE TABLE IF NOT EXISTS request_receipts_meta ("
    + "schema_hash TEXT NOT NULL PRIMARY KEY,"
    + "built_at TEXT NOT NULL"
    + ")",
  "CREATE TABLE IF NOT EXISTS request_receipts ("
    + "operation_id TEXT PRIMARY KEY,"
    + "request_id TEXT NOT NULL,"
    + "actor_id TEXT NOT NULL CHECK (actor_id = 'owner'),"
    + "device_id TEXT NOT NULL,"
    + "credential_id TEXT NOT NULL,"
    + "transport TEXT NOT NULL CHECK (transport IN ('cookie','bearer')),"
    + "host_instance_id TEXT NOT NULL,"
    + "executor TEXT NOT NULL CHECK (executor IN ('http','assistant','agent-work')),"
    + "operation TEXT NOT NULL CHECK (operation IN ("
      + "'capture','settle','resolve','agent-work-complete','agent-work-drain',"
      + "'apply-proposal','reject-proposal','create-document','edit-document'"
    + ")),"
    + "operation_class TEXT NOT NULL CHECK (operation_class IN ("
      + "'operational-transaction','workspace-mutation'"
    + ")),"
    + "state TEXT NOT NULL CHECK (state IN ("
      + "'admitted','succeeded','rejected','failed','cancelled','interrupted'"
    + ")),"
    + "result_code TEXT,"
    + "commit_oid TEXT CHECK (commit_oid IS NULL OR ("
      + "length(commit_oid) = 40 AND commit_oid NOT GLOB '*[^0-9a-f]*'"
    + ")),"
    + "adoption_state TEXT NOT NULL CHECK (adoption_state IN ("
      + "'none','pending','unknown'"
    + ")),"
    + "recovery_required INTEGER NOT NULL CHECK (recovery_required IN (0,1)),"
    + "admitted_at TEXT NOT NULL,"
    + "finished_at TEXT,"
    + "CHECK ((state = 'admitted' AND result_code IS NULL AND finished_at IS NULL "
      + "AND recovery_required = 0) OR "
      + "(state <> 'admitted' AND result_code IS NOT NULL AND finished_at IS NOT NULL)),"
    + "CHECK (state <> 'interrupted' OR recovery_required = 1),"
    + "CHECK ("
      + "(state = 'admitted' AND commit_oid IS NULL AND adoption_state = 'none') OR "
      + "(state = 'interrupted' AND commit_oid IS NULL AND adoption_state = 'unknown') OR "
      + "(state NOT IN ('admitted','interrupted') AND ("
        + "(commit_oid IS NULL AND adoption_state = 'none') OR "
        + "(commit_oid IS NOT NULL AND adoption_state = 'pending')"
      + "))"
    + ")"
    + ")",
  "CREATE INDEX IF NOT EXISTS request_receipts_by_request "
    + "ON request_receipts(request_id, admitted_at DESC)",
  "CREATE INDEX IF NOT EXISTS request_receipts_by_device "
    + "ON request_receipts(device_id, admitted_at DESC)",
  "CREATE INDEX IF NOT EXISTS request_receipts_by_state "
    + "ON request_receipts(state, admitted_at)",
]);

const REQUIRED_TABLE_SHAPES: ReadonlyArray<SqliteTableShape> = Object.freeze([
  { table: "request_receipts_meta", columns: ["schema_hash", "built_at"] },
  {
    table: "request_receipts",
    columns: [
      "operation_id", "request_id", "actor_id",
      "device_id", "credential_id", "transport", "host_instance_id", "executor", "operation",
      "operation_class", "state", "result_code", "commit_oid",
      "adoption_state", "recovery_required", "admitted_at", "finished_at",
    ],
  },
]);

export type RequestReceiptsDb = {
  readonly raw: Database;
  readonly schemaHash: string;
  readonly close: () => void;
};

export type OpenRequestReceiptsDbResult = {
  readonly db: RequestReceiptsDb;
  readonly migration: "fresh" | "ok";
};

export type RequestReceiptsDbError = StoreOpenError;

export function computeRequestReceiptsSchemaHash(): string {
  return computeDdlHash(DDL);
}

export async function openRequestReceiptsDb(input: {
  readonly path: string;
}): Promise<Result<OpenRequestReceiptsDbResult, RequestReceiptsDbError>> {
  const opened = openSimpleStore({
    path: input.path,
    metaTable: "request_receipts_meta",
    ddl: DDL,
    currentHash: computeRequestReceiptsSchemaHash(),
    shapes: REQUIRED_TABLE_SHAPES,
    policy: { kind: "refuse" },
  });
  if (!opened.ok) return err(opened.error);
  const { raw, schemaHash, migration } = opened.value;
  // Unlike rebuildable projections, device-attributed audit cannot be
  // reconstructed from Git. Preserve WAL concurrency, but require SQLite to
  // fsync each committed receipt transition before acknowledging it.
  try {
    raw.run("PRAGMA synchronous = FULL");
  } catch (error) {
    raw.close();
    return err({ kind: "schema-init-failed", cause: errorMessage(error) });
  }
  const db: RequestReceiptsDb = Object.freeze({
    raw,
    schemaHash,
    close: () => raw.close(),
  });
  return ok(Object.freeze({
    db,
    migration: migration === "fresh" ? "fresh" as const : "ok" as const,
  }));
}
