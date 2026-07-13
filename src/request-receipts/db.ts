// request-receipts/db: durable, device-attributed operation audit storage.
// This file owns only schema/open lifecycle; state transitions live in
// request-receipts.ts. Unknown schema changes refuse rather than erase audit.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import { type SqliteTableShape } from "../sqlite-shape";
import { computeDdlHash } from "../sqlite/hash";
import { openSimpleStore, type StoreOpenError } from "../sqlite/open-store";
import { errorMessage } from "../sqlite/error-message";
import { err, ok, type Result } from "../types";

/** Sole frozen predecessor accepted by the private Home upgrade path. */
export const REQUEST_RECEIPTS_N1_SCHEMA_HASH =
  "286a2bebc2214df1c383b952dcc2b3f12699a5874c169952c16a074c56c55a9d";
const REQUEST_RECEIPTS_N1_INVENTORY_SHA256 =
  "608a256d53c1c164c81fae7e34d8476ca86e45436a61e09a51ebe8d14ddb8230";
const REQUEST_RECEIPTS_CURRENT_INVENTORY_SHA256 =
  "22c0de270c85baba33c454561f09b9f63e66f01bdd8bc4864cbcf9ca7067b602";

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
  "CREATE INDEX IF NOT EXISTS request_receipts_prunable "
    + "ON request_receipts(finished_at, operation_id) "
    + "WHERE state IN ('succeeded','rejected')",
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
    validate: (db) => exactSchemaInventory(db, REQUEST_RECEIPTS_CURRENT_INVENTORY_SHA256),
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

/**
 * Upgrade-only exact N-1 route. Ordinary runtime opens intentionally keep
 * refusing the old hash; only a prepared Home upgrade may call this seam.
 */
export async function migrateRequestReceiptsN1(input: {
  readonly path: string;
}): Promise<Result<{ readonly schemaHash: string }, RequestReceiptsDbError>> {
  const opened = openSimpleStore({
    path: input.path,
    metaTable: "request_receipts_meta",
    ddl: DDL,
    currentHash: computeRequestReceiptsSchemaHash(),
    shapes: REQUIRED_TABLE_SHAPES,
    validate: (db) => exactSchemaInventory(db, REQUEST_RECEIPTS_CURRENT_INVENTORY_SHA256),
    policy: {
      kind: "migrate",
      tryMigrate: (db, storedHash) => {
        if (storedHash !== REQUEST_RECEIPTS_N1_SCHEMA_HASH) return false;
        const inventoryError = exactSchemaInventory(db, REQUEST_RECEIPTS_N1_INVENTORY_SHA256);
        if (inventoryError !== null) throw new Error(inventoryError);
        return true;
      },
    },
  });
  if (!opened.ok) return err(opened.error);
  opened.value.raw.close();
  return ok(Object.freeze({ schemaHash: opened.value.schemaHash }));
}

function exactSchemaInventory(db: Database, expected: string): string | null {
  const rows = db.query<{ type: string; name: string; tbl_name: string; sql: string }, []>(
    "SELECT type,name,tbl_name,sql FROM sqlite_schema "
      + "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' "
      + "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END,name",
  ).all().map((row) => ({ type: row.type, name: row.name, table: row.tbl_name, sql: row.sql }));
  const actual = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  return actual === expected ? null : `request receipt schema inventory mismatch: ${actual}`;
}
