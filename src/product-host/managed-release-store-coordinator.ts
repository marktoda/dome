// product-host/managed-release-store-coordinator: kernel-backed Home-global ownership.
//
// SQLite's IMMEDIATE transaction is the mutex. Process death releases it in
// the kernel; no pathname is ever judged stale or unlinked for takeover.

import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { publishPathExclusive } from "../platform/exclusive-rename";

const SCHEMA = "dome.managed-release-store-coordinator/v1";
const DDL = `CREATE TABLE coordinator (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema TEXT NOT NULL CHECK (schema = 'dome.managed-release-store-coordinator/v1'),
  home_root TEXT NOT NULL
) STRICT`;
const MAX_WAIT_MS = 30_000;
const BUSY_SLICE_MS = 100;
const OWNER_BRAND: unique symbol = Symbol("managed-release-store-owner");
const ownerStates = new WeakMap<object, { readonly homeRoot: string; active: boolean }>();
const releaseStoreRank = new AsyncLocalStorage<"global" | "artifact">();

type FileIdentity = Readonly<{ dev: bigint; ino: bigint }>;

/** Opaque live proof that the exact canonical Home-global mutex is held. */
export type ManagedReleaseStoreOwner = Readonly<{ readonly [OWNER_BRAND]: true }>;

export type ManagedReleaseStoreCoordinatorPaths = Readonly<{
  directory: string;
  database: string;
}>;

export type ManagedReleaseStoreCoordinatorResult<T> =
  | Readonly<{ kind: "owned"; value: T }>
  | Readonly<{ kind: "busy" }>;

export type ManagedReleaseStoreCoordinatorOptions = Readonly<{
  waitMs: number;
  /** Test/diagnostic seam; runs immediately before a real coordinator-directory fsync. */
  directoryDurabilityCheckpoint?: ((step: Readonly<{
    subject: string;
    path: string;
    kind: "directory" | "parent-entry";
  }>) => void) | undefined;
}>;

/** Pure path derivation; caller supplies an already-canonical Home root. */
export function managedReleaseStoreCoordinatorPaths(homeRoot: string): ManagedReleaseStoreCoordinatorPaths {
  const directory = join(dirname(homeRoot), ".dome-home-release-store");
  const key = createHash("sha256").update(homeRoot, "utf8").digest("hex");
  return Object.freeze({ directory, database: join(directory, `${key}.db`) });
}

/**
 * Own the Home-global release store using one SQLite IMMEDIATE transaction.
 * This interface never acquires a per-vault lock while ownership is held.
 */
export async function withManagedReleaseStoreCoordinator<T>(
  homeRoot: string,
  operation: (owner: ManagedReleaseStoreOwner) => Promise<T>,
  options: ManagedReleaseStoreCoordinatorOptions,
): Promise<ManagedReleaseStoreCoordinatorResult<T>> {
  assertWaitMs(options.waitMs);
  const enclosingRank = releaseStoreRank.getStore();
  if (enclosingRank !== undefined) {
    throw new Error(enclosingRank === "artifact"
      ? "managed release artifact ownership cannot acquire the global release store"
      : "managed release store ownership cannot be nested");
  }
  const homeGuard = openSync(homeRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const homeBefore = validateCanonicalHomeRoot(homeGuard, homeRoot);
    const paths = managedReleaseStoreCoordinatorPaths(homeRoot);
    await ensureCoordinator(paths, homeRoot, options);
    const directoryGuard = openSync(
      paths.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const directoryBefore = validateOpenedDirectory(directoryGuard, paths.directory);
      const guard = openSync(paths.database, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = validateOpenedFile(guard, paths.database);
        const db = new Database(paths.database, { readwrite: true, create: false });
        let owned = false;
        try {
          assertSameFile(directoryBefore, validateOpenedDirectory(directoryGuard, paths.directory), "directory changed while opening");
          assertSameFile(before, validateOpenedFile(guard, paths.database), "changed while opening");
          configure(db, 0);
          if (!await beginImmediate(db, options.waitMs)) return Object.freeze({ kind: "busy" as const });
          owned = true;
          assertSameFile(directoryBefore, validateOpenedDirectory(directoryGuard, paths.directory), "directory changed before ownership");
          assertSameFile(before, validateOpenedFile(guard, paths.database), "changed before ownership");
          validateDatabase(db, homeRoot);
          assertSameFile(homeBefore, validateCanonicalHomeRoot(homeGuard, homeRoot), "Home root changed before ownership");
          const owner = Object.freeze({}) as ManagedReleaseStoreOwner;
          const ownerState = { homeRoot, active: true };
          ownerStates.set(owner, ownerState);
          let value!: T;
          let operationFailed = false;
          let operationError: unknown;
          try { value = await releaseStoreRank.run("global", async () => operation(owner)); }
          catch (error) {
            operationFailed = true;
            operationError = error;
          }
          finally { ownerState.active = false; }
          const proofErrors = collectReleaseProofErrors([
            () => assertSameFile(homeBefore, validateCanonicalHomeRoot(homeGuard, homeRoot), "Home root changed before release"),
            () => assertSameFile(directoryBefore, validateOpenedDirectory(directoryGuard, paths.directory), "directory changed before release"),
            () => assertSameFile(before, validateOpenedFile(guard, paths.database), "changed before release"),
          ]);
          if (operationFailed) {
            if (proofErrors.length > 0) {
              throw new AggregateError(
                [operationError, ...proofErrors],
                "managed release store operation failed and release reproof also failed",
              );
            }
            throw operationError;
          }
          if (proofErrors.length === 1) throw proofErrors[0];
          if (proofErrors.length > 1) {
            throw new AggregateError(proofErrors, "managed release store release reproof failed");
          }
          return Object.freeze({ kind: "owned" as const, value });
        } finally {
          if (owned) {
            try { db.run("ROLLBACK"); } catch { /* Close still releases the kernel lock. */ }
          }
          db.close();
        }
      } finally {
        closeSync(guard);
      }
    } finally {
      closeSync(directoryGuard);
    }
  } finally {
    closeSync(homeGuard);
  }
}

/** Runtime proof used by release writers before any artifact-local ownership. */
export function assertManagedReleaseStoreOwner(
  owner: ManagedReleaseStoreOwner,
  homeRoot: string,
): void {
  const state = ownerStates.get(owner);
  if (state === undefined || !state.active || state.homeRoot !== homeRoot) {
    throw new Error("managed release store owner is absent, expired, or bound to another Home root");
  }
}

/** Preserve the global → artifact rank across dependency callbacks. */
export async function withManagedReleaseArtifactRank<T>(
  owner: ManagedReleaseStoreOwner,
  homeRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  assertManagedReleaseStoreOwner(owner, homeRoot);
  if (releaseStoreRank.getStore() !== "global") {
    throw new Error("managed release artifact ownership requires the global release store rank");
  }
  return await releaseStoreRank.run("artifact", operation);
}

async function ensureCoordinator(
  paths: ManagedReleaseStoreCoordinatorPaths,
  homeRoot: string,
  options: ManagedReleaseStoreCoordinatorOptions,
): Promise<void> {
  ensurePrivateDirectory(paths.directory);
  if (!present(paths.database)) {
    // Repeat this proof on an incomplete-init retry: a prior failed parent fsync
    // may have left the direct directory visible without a published database.
    syncCoordinatorDirectory(paths.directory, paths.directory, "directory", options);
    syncCoordinatorDirectory(paths.directory, dirname(paths.directory), "parent-entry", options);
    await publishCompleteCoordinator(paths, homeRoot, options);
  }
  const fd = openSync(paths.database, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { validateOpenedFile(fd, paths.database); } finally { closeSync(fd); }
  // Replay even for a present database: a prior attempt may have renamed it
  // successfully and then failed every directory-fsync attempt.
  syncCoordinatorDirectory(paths.directory, paths.directory, "directory", options);
  syncCoordinatorDirectory(paths.directory, dirname(paths.directory), "parent-entry", options);
}

async function publishCompleteCoordinator(
  paths: ManagedReleaseStoreCoordinatorPaths,
  homeRoot: string,
  options: ManagedReleaseStoreCoordinatorOptions,
): Promise<void> {
  const temporary = join(paths.directory, `.init-${process.pid}-${randomUUID()}.db`);
  let guard: number | undefined;
  try {
    guard = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    const before = validateOpenedFile(guard, temporary);
    const db = new Database(temporary, { readwrite: true, create: false });
    try {
      assertSameFile(before, validateOpenedFile(guard, temporary), "initializer changed while opening");
      configure(db, 0, true);
      db.run("BEGIN IMMEDIATE");
      try {
        assertSameFile(before, validateOpenedFile(guard, temporary), "initializer changed before ownership");
        db.run(DDL);
        db.query("INSERT INTO coordinator (singleton, schema, home_root) VALUES (1, ?, ?)").run(SCHEMA, homeRoot);
        db.run("COMMIT");
      } catch (error) {
        try { db.run("ROLLBACK"); } catch { /* Preserve the initialization failure. */ }
        throw error;
      }
    } finally { db.close(); }
    assertSameFile(before, validateOpenedFile(guard, temporary), "initializer changed before publication");
    fsyncSync(guard);
    closeSync(guard);
    guard = undefined;
    try {
      await publishPathExclusive({ source: temporary, target: paths.database });
      syncCoordinatorDirectory(paths.directory, paths.directory, "directory", options);
    } catch (error) {
      // A complete concurrent winner is convergence. An absent, linked, or
      // malformed target remains a closed failure in the subsequent open.
      if (!present(paths.database)) throw error;
      const fd = openSync(paths.database, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { validateOpenedFile(fd, paths.database); } finally { closeSync(fd); }
      syncCoordinatorDirectory(paths.directory, paths.directory, "directory", options);
    }
  } finally {
    if (guard !== undefined) closeSync(guard);
    rmSync(temporary, { force: true });
    rmSync(`${temporary}-journal`, { force: true });
  }
}

function syncCoordinatorDirectory(
  subject: string,
  path: string,
  kind: "directory" | "parent-entry",
  options: ManagedReleaseStoreCoordinatorOptions,
): void {
  options.directoryDurabilityCheckpoint?.(Object.freeze({ subject, path, kind }));
  syncPath(path);
}

function ensurePrivateDirectory(path: string): void {
  if (!present(path)) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  }
  const info = lstatSync(path, { bigint: true });
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : info.uid;
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o777n) !== 0o700n) {
    throw new Error("managed release coordinator directory is not private, direct, and owned");
  }
}

function collectReleaseProofErrors(proofs: ReadonlyArray<() => void>): unknown[] {
  const errors: unknown[] = [];
  for (const proof of proofs) {
    try { proof(); } catch (error) { errors.push(error); }
  }
  return errors;
}

function validateCanonicalHomeRoot(fd: number, path: string): FileIdentity {
  if (path !== resolve(path) || realpathSync(path) !== path) {
    throw new Error("managed Home root must be absolute, normalized, canonical, and direct");
  }
  const opened = fstatSync(fd, { bigint: true });
  const current = lstatSync(path, { bigint: true });
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : current.uid;
  if (!opened.isDirectory() || !current.isDirectory() || current.isSymbolicLink() || current.uid !== uid ||
    opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error("managed Home root is not a stable direct owned directory");
  }
  return Object.freeze({ dev: opened.dev, ino: opened.ino });
}

function validateOpenedDirectory(fd: number, path: string): FileIdentity {
  const opened = fstatSync(fd, { bigint: true });
  const current = lstatSync(path, { bigint: true });
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : current.uid;
  if (!opened.isDirectory() || !current.isDirectory() || current.isSymbolicLink() ||
    current.uid !== uid || (current.mode & 0o777n) !== 0o700n ||
    opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error("managed release coordinator directory is not stable, private, direct, and owned");
  }
  return Object.freeze({ dev: opened.dev, ino: opened.ino });
}

function validateOpenedFile(fd: number, path: string): FileIdentity {
  const opened = fstatSync(fd, { bigint: true });
  const current = lstatSync(path, { bigint: true });
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : current.uid;
  if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n ||
    current.uid !== uid || (current.mode & 0o777n) !== 0o600n ||
    opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error("managed release coordinator database is not a stable private direct owned file");
  }
  return Object.freeze({ dev: opened.dev, ino: opened.ino });
}

function assertSameFile(
  expected: FileIdentity,
  actual: FileIdentity,
  suffix: string,
): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new Error(`managed release coordinator ${suffix}`);
  }
}

function configure(db: Database, busyTimeoutMs: number, initializing = false): void {
  db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  const journal = initializing
    ? db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = DELETE").get()
    : db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  if (journal?.journal_mode.toLowerCase() !== "delete") {
    throw new Error("managed release coordinator must use DELETE journal mode");
  }
  if (db.query<{ locking_mode: string }, []>("PRAGMA locking_mode").get()?.locking_mode.toLowerCase() !== "normal") {
    throw new Error("managed release coordinator must use NORMAL locking mode");
  }
  db.run("PRAGMA synchronous = FULL");
  if (db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous !== 2) {
    throw new Error("managed release coordinator must use FULL synchronous mode");
  }
}

async function beginImmediate(db: Database, waitMs: number): Promise<boolean> {
  const deadline = performance.now() + waitMs;
  while (true) {
    const remainingBeforeAttempt = Math.max(0, deadline - performance.now());
    db.run(`PRAGMA busy_timeout = ${Math.min(BUSY_SLICE_MS, Math.floor(remainingBeforeAttempt))}`);
    try {
      db.run("BEGIN IMMEDIATE");
      return true;
    } catch (error) {
      if (!isBusy(error)) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      await Bun.sleep(Math.min(10, remaining));
    }
  }
}

function assertWaitMs(waitMs: number): void {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) {
    throw new Error(`managed release coordinator waitMs must be an integer from 0 through ${MAX_WAIT_MS}`);
  }
}

function validateDatabase(db: Database, homeRoot: string): void {
  const sqlite = db.query<{ type: string; name: string; sql: string | null }, []>(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all();
  const schema = sqlite[0];
  if (sqlite.length !== 1 || schema?.type !== "table" || schema.name !== "coordinator" || schema.sql === null ||
    compact(schema.sql) !== compact(DDL)) {
    throw new Error("managed release coordinator has an unknown schema layout");
  }
  const rows = db.query<{ singleton: number; schema: string; home_root: string }, []>(
    "SELECT singleton, schema, home_root FROM coordinator",
  ).all();
  if (rows.length !== 1 || rows[0]?.singleton !== 1 || rows[0].schema !== SCHEMA || rows[0].home_root !== homeRoot) {
    throw new Error("managed release coordinator identity is invalid");
  }
  if (db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
    throw new Error("managed release coordinator failed integrity_check");
  }
}

function compact(sql: string): string { return sql.replace(/\s+/g, " ").trim(); }

function syncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "SQLITE_BUSY" || String((error as { message?: unknown }).message ?? error).includes("database is locked");
}

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}
