// sqlite/snapshot: read-only, WAL-aware SQLite snapshot mechanics shared by
// offline backup and the Product Host upgrade transaction. Policy (which
// stores, where they live, and whether absence is allowed) belongs to callers.

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Produce one consistent standalone database without opening the source.
 * SQLite may update `-shm` lock bytes or checkpoint when even a read-only
 * connection becomes the last connection, so the quiesced main file and WAL
 * are first copied into private staging. VACUUM INTO then observes committed
 * WAL state there; validation proves the result is standalone and readable.
 */
export async function snapshotSqliteReadonly(input: {
  readonly source: string;
  readonly destination: string;
}): Promise<void> {
  const sourceInfo = await lstat(input.source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error(`SQLite snapshot source is not a regular file: ${input.source}`);
  }
  const scratch = join(dirname(input.destination), `.sqlite-snapshot-${randomUUID()}`);
  await mkdir(scratch, { mode: 0o700 });
  await chmod(scratch, 0o700);
  const stagedSource = join(scratch, basename(input.source));
  try {
    await copyFile(input.source, stagedSource, constants.COPYFILE_EXCL);
    const wal = `${input.source}-wal`;
    try {
      const walInfo = await lstat(wal);
      if (!walInfo.isFile() || walInfo.isSymbolicLink()) throw new Error(`SQLite WAL is not a regular file: ${wal}`);
      await copyFile(wal, `${stagedSource}-wal`, constants.COPYFILE_EXCL);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const db = new Database(stagedSource, { readonly: true, create: false });
    try {
      assertQuickCheck(db, `SQLite quick_check failed: ${basename(input.source)}`);
      db.query("VACUUM INTO ?").run(input.destination);
    } finally { db.close(); }
    await validateSqliteSnapshot(input.destination);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Validate one standalone database without creating, migrating, or opening a store. */
export async function validateSqliteSnapshot(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`SQLite snapshot is not a regular file: ${path}`);
  }
  const db = new Database(path, { readonly: true, create: false });
  try {
    assertQuickCheck(db, `staged SQLite quick_check failed: ${basename(path)}`);
  } finally {
    db.close();
  }
}

/** Read the one closed schema-evidence row without invoking store migrations. */
export async function readSqliteSchemaHash(path: string, metaTable: string): Promise<string> {
  if (!/^[a-z][a-z0-9_]*$/.test(metaTable)) throw new Error("SQLite meta-table name is invalid");
  const db = new Database(path, { readonly: true, create: false });
  try {
    const rows = db.query<{ schema_hash: string }, []>(`SELECT schema_hash FROM ${metaTable}`).all();
    const hash = rows[0]?.schema_hash;
    if (rows.length !== 1 || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`SQLite schema evidence is missing or invalid: ${basename(path)}`);
    }
    return hash;
  } finally {
    db.close();
  }
}

function assertQuickCheck(db: Database, error: string): void {
  const rows = db.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
  if (rows.length !== 1 || rows[0]?.quick_check !== "ok") throw new Error(error);
}
