// operational-state/writer-barrier: one cross-process admission seam for
// writers of a vault's gitignored operational state.
//
// An admitted process holds a rollback-journal SQLite SHARED lock for the
// complete writer lifetime. Upgrade engagement drains those readers with
// BEGIN EXCLUSIVE, records a durable transaction id, then releases the SQLite
// lock. Later openers can read the durable closed state but cannot receive a
// lease. The coordinator intentionally does not use Dome's WAL configuration:
// in WAL mode BEGIN EXCLUSIVE does not exclude readers.

import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const OPERATIONAL_WRITER_BARRIER_SCHEMA =
  "dome.operational-writer-barrier/v1" as const;

const TABLE = "operational_writer_barrier";
const COORDINATOR_NAME = "operational-writers.db";
const SQLITE_BUSY_SLICE_MS = 25;
const ADMISSION_WAIT_MS = 1_000;
const EXCLUSIVE_WAIT_MS = 30_000;
const EXCLUSIVE_RETRY_MS = 10;
const TRANSACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DDL = `CREATE TABLE ${TABLE} (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema TEXT NOT NULL CHECK (schema = '${OPERATIONAL_WRITER_BARRIER_SCHEMA}'),
  blocked_transaction_id TEXT,
  blocked_at TEXT,
  CHECK ((blocked_transaction_id IS NULL AND blocked_at IS NULL) OR
         (blocked_transaction_id IS NOT NULL AND blocked_at IS NOT NULL))
) STRICT`;

type BarrierRow = {
  readonly singleton: number;
  readonly schema: string;
  readonly blocked_transaction_id: string | null;
  readonly blocked_at: string | null;
};

export type OperationalWriterLease = {
  readonly vaultPath: string;
  /** Idempotent. Releases this acquisition's SQLite SHARED lock. */
  readonly close: () => void;
};

export type OperationalWriterAdmissionError =
  | {
      readonly kind: "write-admission-closed";
      readonly transactionId: string;
      readonly blockedAt: string;
    }
  | { readonly kind: "coordination-busy"; readonly cause: string }
  | { readonly kind: "coordination-invalid"; readonly cause: string };

export type OperationalWriterAdmission =
  | { readonly ok: true; readonly lease: OperationalWriterLease }
  | { readonly ok: false; readonly error: OperationalWriterAdmissionError };

export type EngageOperationalWriterBarrierResult =
  | {
      readonly ok: true;
      /** True when this transaction had already durably closed admission. */
      readonly resumed: boolean;
      readonly blockedAt: string;
    }
  | {
      readonly ok: false;
      readonly error:
        | OperationalWriterAdmissionError
        | {
            readonly kind: "owned-by-another-transaction";
            readonly transactionId: string;
          };
    };

export type OperationalWriterBarrierInspection = {
  readonly blocked: boolean;
  readonly transactionId: string | null;
  readonly blockedAt: string | null;
};

export type OperationalWriterBarrierOwner = {
  readonly transactionId: string;
  readonly blockedAt: string;
  /** Clear durable ownership inside this still-EXCLUSIVE transaction. */
  readonly release: (
    validateAndRemoveExternalEvidence: () => Promise<void>,
  ) => Promise<void>;
};

export type OperationalWriterBarrierOwnership<T> =
  | { readonly kind: "owned"; readonly value: T }
  | { readonly kind: "not-owned"; readonly transactionId: string | null };

type OpenedCoordinator = {
  readonly db: Database;
  readonly vaultPath: string;
};

export function operationalWriterCoordinatorPath(vaultPath: string): string {
  return join(canonicalVault(vaultPath), ".dome", "state", "locks", COORDINATOR_NAME);
}

/**
 * Acquire a close-once writer lease. BEGIN alone is not the lock: the
 * singleton SELECT performs the real read that holds SHARED in DELETE mode.
 */
export async function acquireOperationalWriterLease(input: {
  readonly vaultPath: string;
  readonly command: string;
}): Promise<OperationalWriterAdmission> {
  if (input.command.trim().length === 0) {
    return invalidAdmission("operational writer command must be non-empty");
  }

  let vaultPath: string;
  try {
    vaultPath = canonicalVault(input.vaultPath);
  } catch (error) {
    return admissionFailure(error);
  }

  let opened: OpenedCoordinator | null = null;
  try {
    opened = await openCoordinatorForAdmission(vaultPath);
    opened.db.run("BEGIN");
    const row = readBarrierRow(opened.db); // real read => held SHARED lock
    if (row.blocked_transaction_id !== null) {
      opened.db.run("ROLLBACK");
      opened.db.close();
      return Object.freeze({
        ok: false as const,
        error: Object.freeze({
          kind: "write-admission-closed" as const,
          transactionId: row.blocked_transaction_id,
          blockedAt: row.blocked_at!,
        }),
      });
    }
    return admittedLease(opened);
  } catch (error) {
    closeFailedTransaction(opened);
    return admissionFailure(error);
  }
}

/**
 * Drain admitted writers and durably close admission. Repeating the same
 * transaction is the crash-recovery path; a different transaction cannot
 * take over the closed coordinator.
 */
export async function engageOperationalWriterBarrier(input: {
  readonly vaultPath: string;
  readonly transactionId: string;
  readonly now?: Date;
}): Promise<EngageOperationalWriterBarrierResult> {
  assertTransactionId(input.transactionId);
  let opened: OpenedCoordinator | null = null;
  try {
    opened = await openCoordinatorForExclusive(input.vaultPath);
    await beginExclusive(opened.db);
    const row = readBarrierRow(opened.db);
    if (row.blocked_transaction_id !== null) {
      if (row.blocked_transaction_id !== input.transactionId) {
        opened.db.run("ROLLBACK");
        opened.db.close();
        return Object.freeze({
          ok: false as const,
          error: Object.freeze({
            kind: "owned-by-another-transaction" as const,
            transactionId: row.blocked_transaction_id,
          }),
        });
      }
      opened.db.run("COMMIT");
      opened.db.close();
      return Object.freeze({
        ok: true as const,
        resumed: true,
        blockedAt: row.blocked_at!,
      });
    }

    const blockedAt = exactTimestamp(input.now ?? new Date());
    const changed = opened.db.query(
      `UPDATE ${TABLE}
       SET blocked_transaction_id = ?, blocked_at = ?
       WHERE singleton = 1 AND blocked_transaction_id IS NULL`,
    ).run(input.transactionId, blockedAt).changes;
    if (changed !== 1) throw new Error("operational writer coordinator state changed during engagement");
    readBarrierRow(opened.db);
    opened.db.run("COMMIT");
    opened.db.close();
    return Object.freeze({ ok: true as const, resumed: false, blockedAt });
  } catch (error) {
    closeFailedTransaction(opened);
    return barrierFailure(error);
  }
}

/**
 * Clear a matching barrier only after terminal upgrade evidence validates.
 * The callback runs while EXCLUSIVE is held. If it throws or the process
 * crashes, the durable blocked row remains (or its transaction rolls back).
 */
export async function releaseOperationalWriterBarrier(input: {
  readonly vaultPath: string;
  readonly transactionId: string;
  readonly validateAndRemoveExternalEvidence: () => Promise<void>;
}): Promise<void> {
  const owned = await withOperationalWriterBarrierOwnership({
    vaultPath: input.vaultPath,
    transactionId: input.transactionId,
  }, async (owner) => {
    await owner.release(input.validateAndRemoveExternalEvidence);
  });
  if (owned.kind !== "owned") {
    throw new Error("operational writer barrier is not owned by this transaction");
  }
}

/**
 * Serialize recovery for one durably engaged transaction with SQLite's
 * kernel-managed EXCLUSIVE lock. No PID/stale-file protocol participates;
 * process death releases the lock while the committed blocked row remains.
 */
export async function withOperationalWriterBarrierOwnership<T>(
  input: {
    readonly vaultPath: string;
    readonly transactionId: string;
  },
  operation: (owner: OperationalWriterBarrierOwner) => Promise<T>,
): Promise<OperationalWriterBarrierOwnership<T>> {
  assertTransactionId(input.transactionId);
  const opened = await openCoordinatorForExclusive(input.vaultPath);
  try {
    await beginExclusive(opened.db);
    const row = readBarrierRow(opened.db);
    if (row.blocked_transaction_id !== input.transactionId) {
      opened.db.run("COMMIT");
      return Object.freeze({
        kind: "not-owned" as const,
        transactionId: row.blocked_transaction_id,
      });
    }

    let released = false;
    const owner: OperationalWriterBarrierOwner = Object.freeze({
      transactionId: input.transactionId,
      blockedAt: row.blocked_at!,
      release: async (validateAndRemoveExternalEvidence) => {
        if (released) throw new Error("operational writer barrier owner already released");
        await validateAndRemoveExternalEvidence();
        const changed = opened.db.query(
          `UPDATE ${TABLE}
           SET blocked_transaction_id = NULL, blocked_at = NULL
           WHERE singleton = 1 AND blocked_transaction_id = ?`,
        ).run(input.transactionId).changes;
        if (changed !== 1) {
          throw new Error("operational writer barrier ownership changed during release");
        }
        readBarrierRow(opened.db);
        released = true;
      },
    });
    const value = await operation(owner);
    opened.db.run("COMMIT");
    return Object.freeze({ kind: "owned" as const, value });
  } catch (error) {
    try { opened.db.run("ROLLBACK"); } catch {}
    throw error;
  } finally {
    opened.db.close();
  }
}

/** Strict inspection used by upgrade recovery and diagnostics. */
export async function inspectOperationalWriterBarrier(
  vaultPath: string,
): Promise<OperationalWriterBarrierInspection> {
  const opened = openCoordinator(vaultPath);
  try {
    const row = readBarrierRow(opened.db);
    return Object.freeze({
      blocked: row.blocked_transaction_id !== null,
      transactionId: row.blocked_transaction_id,
      blockedAt: row.blocked_at,
    });
  } finally {
    opened.db.close();
  }
}

function admittedLease(opened: OpenedCoordinator): OperationalWriterAdmission {
  let closed = false;
  return Object.freeze({
    ok: true as const,
    lease: Object.freeze({
      vaultPath: opened.vaultPath,
      close: () => {
        if (closed) return;
        closed = true;
        try { opened.db.run("ROLLBACK"); } finally { opened.db.close(); }
      },
    }),
  });
}

function openCoordinator(vaultInput: string): OpenedCoordinator {
  const vaultPath = canonicalVault(vaultInput);
  const dome = join(vaultPath, ".dome");
  const state = join(dome, "state");
  const locks = join(state, "locks");
  ensureOwnedDirectory(dome);
  ensureOwnedDirectory(state);
  ensureOwnedDirectory(locks);
  const path = join(locks, COORDINATOR_NAME);
  ensureCoordinatorFile(path);

  const before = lstatSync(path);
  const initializationPending = before.size === 0;
  const db = new Database(path);
  try {
    const after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("operational writer coordinator changed while opening");
    }
    const initialized = initializationPending
      ? initializeEmptyCoordinator(db)
      : (configureCoordinator(db), initializeOrValidate(db));
    if (initialized) {
      fsyncPath(path);
      fsyncPath(dirname(path));
    }
    return Object.freeze({ db, vaultPath });
  } catch (error) {
    db.close();
    throw error;
  }
}

async function openCoordinatorForAdmission(vaultInput: string): Promise<OpenedCoordinator> {
  const started = Date.now();
  while (true) {
    try { return openCoordinator(vaultInput); }
    catch (error) {
      if (!isBusy(error) || Date.now() - started >= ADMISSION_WAIT_MS) throw error;
      // A concurrent first opener may have initialized the once-empty file.
      // Close/reopen so this attempt observes the committed schema instead of
      // continuing to demand EXCLUSIVE from a stale size=0 observation.
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, EXCLUSIVE_RETRY_MS));
    }
  }
}

async function openCoordinatorForExclusive(vaultInput: string): Promise<OpenedCoordinator> {
  const started = Date.now();
  while (true) {
    try { return openCoordinator(vaultInput); }
    catch (error) {
      if (!isBusy(error) || Date.now() - started >= EXCLUSIVE_WAIT_MS) throw error;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, EXCLUSIVE_RETRY_MS));
    }
  }
}

function configureCoordinator(db: Database): void {
  db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_SLICE_MS}`);
  let journal = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  if (journal?.journal_mode.toLowerCase() !== "delete") {
    journal = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = DELETE").get();
  }
  if (journal?.journal_mode.toLowerCase() !== "delete") {
    throw new Error("operational writer coordinator must use DELETE journal mode");
  }
  let locking = db.query<{ locking_mode: string }, []>("PRAGMA locking_mode").get();
  if (locking?.locking_mode.toLowerCase() !== "normal") {
    locking = db.query<{ locking_mode: string }, []>("PRAGMA locking_mode = NORMAL").get();
  }
  if (locking?.locking_mode.toLowerCase() !== "normal") {
    throw new Error("operational writer coordinator must use NORMAL locking mode");
  }
  db.run("PRAGMA synchronous = FULL");
  const synchronous = db.query<{ synchronous: number }, []>("PRAGMA synchronous").get();
  if (synchronous?.synchronous !== 2) {
    throw new Error("operational writer coordinator must use FULL synchronous mode");
  }
}

function initializeEmptyCoordinator(db: Database): boolean {
  configureCoordinator(db);
  db.run("BEGIN EXCLUSIVE");
  let initialized = false;
  try {
    if (readUserSchema(db).length === 0) {
      db.run(DDL);
      db.query(
        `INSERT INTO ${TABLE}
         (singleton, schema, blocked_transaction_id, blocked_at)
         VALUES (1, ?, NULL, NULL)`,
      ).run(OPERATIONAL_WRITER_BARRIER_SCHEMA);
      initialized = true;
    }
    validateSchema(db);
    const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error("operational writer coordinator failed integrity_check");
    }
    readBarrierRow(db);
    db.run("COMMIT");
    return initialized;
  } catch (error) {
    try { db.run("ROLLBACK"); } catch {}
    throw error;
  }
}

function initializeOrValidate(db: Database): boolean {
  let schema = readUserSchema(db);
  let initialized = false;
  if (schema.length === 0) {
    db.run("BEGIN EXCLUSIVE");
    try {
      // A second first opener may have observed an empty file before this
      // connection acquired EXCLUSIVE. Re-read under the lock before CREATE.
      schema = readUserSchema(db);
      if (schema.length === 0) {
        db.run(DDL);
        db.query(
          `INSERT INTO ${TABLE}
           (singleton, schema, blocked_transaction_id, blocked_at)
           VALUES (1, ?, NULL, NULL)`,
        ).run(OPERATIONAL_WRITER_BARRIER_SCHEMA);
        initialized = true;
      }
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }
  }

  validateSchema(db);
  const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error("operational writer coordinator failed integrity_check");
  }
  readBarrierRow(db);
  return initialized;
}

type SchemaRow = {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
};

function readUserSchema(db: Database): ReadonlyArray<SchemaRow> {
  return db.query<SchemaRow, []>(
    `SELECT type, name, tbl_name, sql
     FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type, name`,
  ).all();
}

function validateSchema(db: Database): void {
  const schema = readUserSchema(db);
  const only = schema[0];
  if (
    schema.length !== 1 || only === undefined || only.type !== "table" ||
    only.name !== TABLE || only.tbl_name !== TABLE || only.sql === null ||
    compactSql(only.sql) !== compactSql(DDL)
  ) {
    throw new Error("operational writer coordinator has an unknown schema layout");
  }

  const table = db.query<{
    readonly name: string;
    readonly type: string;
    readonly ncol: number;
    readonly wr: number;
    readonly strict: number;
  }, []>("PRAGMA table_list").all().find((row) => row.name === TABLE);
  if (table === undefined || table.type !== "table" || table.ncol !== 4 || table.wr !== 0 || table.strict !== 1) {
    throw new Error("operational writer coordinator table is not the strict v1 shape");
  }

  const columns = db.query<{
    readonly cid: number;
    readonly name: string;
    readonly type: string;
    readonly notnull: number;
    readonly dflt_value: string | null;
    readonly pk: number;
    readonly hidden: number;
  }, []>(`PRAGMA table_xinfo(${TABLE})`).all();
  const shape = columns.map(({ name, type, notnull, dflt_value, pk, hidden }) =>
    [name, type, notnull, dflt_value, pk, hidden]);
  const expected = [
    ["singleton", "INTEGER", 0, null, 1, 0],
    ["schema", "TEXT", 1, null, 0, 0],
    ["blocked_transaction_id", "TEXT", 0, null, 0, 0],
    ["blocked_at", "TEXT", 0, null, 0, 0],
  ];
  if (JSON.stringify(shape) !== JSON.stringify(expected)) {
    throw new Error("operational writer coordinator columns are not the v1 shape");
  }
}

function readBarrierRow(db: Database): BarrierRow {
  const rows = db.query<BarrierRow, []>(
    `SELECT singleton, schema, blocked_transaction_id, blocked_at FROM ${TABLE}`,
  ).all();
  const row = rows[0];
  const unblocked = row !== undefined &&
    row.blocked_transaction_id === null && row.blocked_at === null;
  const blocked = row !== undefined &&
    row.blocked_transaction_id !== null && row.blocked_at !== null &&
    TRANSACTION_ID.test(row.blocked_transaction_id) && isExactTimestamp(row.blocked_at);
  if (
    rows.length !== 1 || row === undefined || row.singleton !== 1 ||
    row.schema !== OPERATIONAL_WRITER_BARRIER_SCHEMA || (!unblocked && !blocked)
  ) {
    throw new Error("operational writer coordinator singleton is invalid");
  }
  return row;
}

async function beginExclusive(db: Database): Promise<void> {
  const started = Date.now();
  while (true) {
    try {
      db.run("BEGIN EXCLUSIVE");
      return;
    } catch (error) {
      if (!isBusy(error) || Date.now() - started >= EXCLUSIVE_WAIT_MS) throw error;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, EXCLUSIVE_RETRY_MS));
    }
  }
}

function canonicalVault(path: string): string {
  return realpathSync(resolve(path));
}

function ensureOwnedDirectory(path: string): void {
  let created = false;
  try {
    mkdirSync(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== resolve(path)) {
    throw new Error(`operational writer coordination path is not a direct directory: ${path}`);
  }
  if (created) {
    chmodSync(path, 0o700);
    fsyncPath(path);
    fsyncPath(dirname(path));
  }
}

function ensureCoordinatorFile(path: string): void {
  let created = false;
  try {
    const fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollowFlag(),
      0o600,
    );
    closeSync(fd);
    created = true;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  if (created) chmodSync(path, 0o600);
  const info = lstatSync(path);
  if (
    !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
    realpathSync(path) !== resolve(path) || (info.mode & 0o777) !== 0o600
  ) {
    throw new Error("operational writer coordinator must be a direct private regular file");
  }
  if (created) {
    fsyncPath(path);
    fsyncPath(dirname(path));
  }
}

function fsyncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | noFollowFlag());
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
}

function assertTransactionId(value: string): void {
  if (!TRANSACTION_ID.test(value)) {
    throw new Error("operational writer barrier transaction id is invalid");
  }
}

function exactTimestamp(value: Date): string {
  const timestamp = value.toISOString();
  if (!isExactTimestamp(timestamp)) throw new Error("operational writer barrier timestamp is invalid");
  return timestamp;
}

function isExactTimestamp(value: string): boolean {
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function compactSql(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/;$/, "");
}

function closeFailedTransaction(opened: OpenedCoordinator | null): void {
  if (opened === null) return;
  try { opened.db.run("ROLLBACK"); } catch {}
  try { opened.db.close(); } catch {}
}

function admissionFailure(error: unknown): OperationalWriterAdmission {
  const cause = message(error);
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({
      kind: isBusy(error) ? "coordination-busy" as const : "coordination-invalid" as const,
      cause,
    }),
  });
}

function invalidAdmission(cause: string): OperationalWriterAdmission {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ kind: "coordination-invalid" as const, cause }),
  });
}

function barrierFailure(error: unknown): EngageOperationalWriterBarrierResult {
  const cause = message(error);
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({
      kind: isBusy(error) ? "coordination-busy" as const : "coordination-invalid" as const,
      cause,
    }),
  });
}

function isBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { readonly code?: unknown }).code === "SQLITE_BUSY";
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { readonly code?: unknown }).code === code;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
