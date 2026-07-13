// product-host/home-lifecycle-suspension: crash-honest quiescence for the
// supervised macOS Home. A tiny ownership database provides the kernel lock;
// a separate rollback-journal database can durably advance recovery evidence
// while that outer lock remains held.

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { inspectOperationalWriterBarrier } from "../operational-state/writer-barrier";
import { activateLaunchAgent, waitForLaunchAgentDrain } from "../platform/launchd";
import { resolveServiceDeps, vaultServiceSlug, type ServiceDeps } from "../surface/service-probe";
import { homeInstallationPaths, readHomeInstallation, type HomeInstallationDeps } from "./home-installation";

export const HOME_LIFECYCLE_SUSPENSION_SCHEMA =
  "dome.home-lifecycle-suspension/v1" as const;
const OWNERSHIP_SCHEMA = "dome.home-lifecycle-suspension-ownership/v1" as const;
const JOURNAL_TABLE = "home_lifecycle_suspension";
const OWNERSHIP_TABLE = "home_lifecycle_suspension_ownership";
const JOURNAL_NAME = "home-lifecycle-suspension.db";
const OWNERSHIP_NAME = "home-lifecycle-suspension-ownership.db";
const BUSY_SLICE_MS = 25;
const OWNERSHIP_WAIT_MS = 30_000;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

const OWNERSHIP_DDL = `CREATE TABLE ${OWNERSHIP_TABLE} (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema TEXT NOT NULL CHECK (schema = '${OWNERSHIP_SCHEMA}')
) STRICT`;

const JOURNAL_DDL = `CREATE TABLE ${JOURNAL_TABLE} (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema TEXT NOT NULL CHECK (schema = '${HOME_LIFECYCLE_SUSPENSION_SCHEMA}'),
  phase TEXT NOT NULL CHECK (phase IN ('suspending', 'suspended', 'resuming')),
  purpose TEXT NOT NULL CHECK (purpose IN ('backup', 'upgrade')),
  operation_id TEXT NOT NULL,
  vault TEXT NOT NULL,
  prior_loaded INTEGER NOT NULL CHECK (prior_loaded IN (0, 1)),
  installation_path TEXT NOT NULL,
  installation_sha256 TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_version TEXT NOT NULL,
  plist_path TEXT NOT NULL,
  plist_sha256 TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  phase_changed_at TEXT NOT NULL,
  last_error TEXT
) STRICT`;

export type HomeSuspensionPurpose = "backup" | "upgrade";
export type HomeSuspensionPhase = "suspending" | "suspended" | "resuming";

export type HomeLifecycleSuspension = {
  readonly schema: typeof HOME_LIFECYCLE_SUSPENSION_SCHEMA;
  readonly phase: HomeSuspensionPhase;
  readonly purpose: HomeSuspensionPurpose;
  readonly operationId: string;
  readonly vault: string;
  readonly priorLoaded: boolean;
  readonly installationPath: string;
  readonly installationSha256: string;
  readonly artifactId: string;
  readonly artifactVersion: string;
  readonly plistPath: string;
  readonly plistSha256: string;
  readonly requestedAt: string;
  readonly phaseChangedAt: string;
  readonly lastError: string | null;
};

export type HomeLifecycleSuspensionInspection =
  | { readonly kind: "inactive" }
  | { readonly kind: "active"; readonly suspension: HomeLifecycleSuspension }
  | { readonly kind: "invalid"; readonly error: string };

export type HomeLifecycleMutationResult<T> =
  | { readonly kind: "owned"; readonly value: T }
  | { readonly kind: "suspended"; readonly suspension: HomeLifecycleSuspension };

type SuspensionResultBase<T> = {
  readonly operationId: string;
  readonly recovered: boolean;
  readonly operationRan: boolean;
  readonly value?: T;
};

export type SupervisedHomeSuspensionResult<T> =
  | (SuspensionResultBase<T> & { readonly kind: "not-required" })
  | (SuspensionResultBase<T> & { readonly kind: "ready" })
  | (SuspensionResultBase<T> & {
      readonly kind: "deferred";
      readonly reason: "write-barrier-closed";
      readonly transactionId: string;
    })
  | (SuspensionResultBase<T> & {
      readonly kind: "failed";
      readonly error: string;
    });

export type HomeLifecycleSuspensionDeps = ServiceDeps & HomeInstallationDeps & {
  readonly readiness?: (() => Promise<boolean>) | undefined;
  readonly readinessTimeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
};

type JournalRow = {
  readonly singleton: number;
  readonly schema: string;
  readonly phase: string;
  readonly purpose: string;
  readonly operation_id: string;
  readonly vault: string;
  readonly prior_loaded: number;
  readonly installation_path: string;
  readonly installation_sha256: string;
  readonly artifact_id: string;
  readonly artifact_version: string;
  readonly plist_path: string;
  readonly plist_sha256: string;
  readonly requested_at: string;
  readonly phase_changed_at: string;
  readonly last_error: string | null;
};

type Evidence = Pick<HomeLifecycleSuspension,
  "installationPath" | "installationSha256" | "artifactId" |
  "artifactVersion" | "plistPath" | "plistSha256">;

export function homeLifecycleCoordinatorPath(vaultPath: string): string {
  return join(canonicalVault(vaultPath), ".dome", "state", "locks", JOURNAL_NAME);
}

/** Read-only diagnosis. Partial, corrupt, redirected, or foreign state is invalid. */
export async function inspectHomeLifecycleSuspension(
  vaultPath: string,
): Promise<HomeLifecycleSuspensionInspection> {
  let vault: string;
  try { vault = await realpath(resolve(vaultPath)); }
  catch (error) { return Object.freeze({ kind: "invalid", error: message(error) }); }
  const paths = coordinatorPaths(vault);
  const journalExists = existsSync(paths.journal);
  const ownershipExists = existsSync(paths.ownership);
  if (!journalExists && !ownershipExists) return Object.freeze({ kind: "inactive" });
  if (!journalExists || !ownershipExists) {
    return Object.freeze({ kind: "invalid", error: "Home lifecycle suspension coordinator layout is incomplete" });
  }
  try {
    validateExistingCoordinatorFile(paths.journal, "journal");
    validateExistingCoordinatorFile(paths.ownership, "ownership");
    const ownership = openEstablished(paths.ownership, OWNERSHIP_DDL, validateOwnershipRow);
    const journal = openEstablished(paths.journal, JOURNAL_DDL, () => {});
    try {
      validateOwnershipRow(ownership);
      const active = readActive(journal, vault);
      return active === null
        ? Object.freeze({ kind: "inactive" as const })
        : Object.freeze({ kind: "active" as const, suspension: active });
    } finally {
      journal.close();
      ownership.close();
    }
  } catch (error) {
    return Object.freeze({ kind: "invalid", error: message(error) });
  }
}

/**
 * The sole lifecycle-mutation ownership seam. The callback runs while
 * BEGIN IMMEDIATE is held; an active durable suspension denies it.
 */
export async function withHomeLifecycleMutation<T>(
  vaultPath: string,
  operation: () => Promise<T>,
): Promise<HomeLifecycleMutationResult<T>> {
  const vault = await realpath(resolve(vaultPath));
  const pair = await openCoordinatorPair(vault);
  try {
    // Fast denial avoids waiting behind a suspension's long Tx2. The second
    // read under ownership closes the race with a concurrently publishing Tx1.
    const published = readActive(pair.journal, vault);
    if (published !== null) {
      return Object.freeze({ kind: "suspended" as const, suspension: published });
    }
    await beginImmediate(pair.ownership);
    validateOwnershipRow(pair.ownership);
    const active = readActive(pair.journal, vault);
    if (active !== null) {
      pair.ownership.run("ROLLBACK");
      return Object.freeze({ kind: "suspended" as const, suspension: active });
    }
    const value = await operation();
    pair.ownership.run("COMMIT");
    return Object.freeze({ kind: "owned" as const, value });
  } catch (error) {
    rollback(pair.ownership);
    throw error;
  } finally {
    closePair(pair);
  }
}

/**
 * Bracket a quiesced operation. Durable phase transitions use the journal
 * connection while Tx2 holds the ownership database's kernel writer lock.
 */
export async function withSupervisedHomeSuspended<T>(input: {
  readonly vaultPath: string;
  readonly purpose: HomeSuspensionPurpose;
  readonly operationId?: string | undefined;
  readonly recoverExisting?: boolean | undefined;
}, operation: () => Promise<T>, deps: HomeLifecycleSuspensionDeps = {}): Promise<SupervisedHomeSuspensionResult<T>> {
  const vault = await realpath(resolve(input.vaultPath));
  const requestedOperationId = input.operationId ?? randomUUID();
  assertOperationId(requestedOperationId);
  if (input.purpose === "upgrade" && input.operationId === undefined) {
    throw new Error("upgrade suspension requires an explicit operation id");
  }
  const service = resolveServiceDeps(deps);
  if (service.platform !== "darwin" || service.uid === null) {
    throw new Error("supervised Home suspension requires macOS launchd");
  }
  const label = `com.dome.home.${vaultServiceSlug(vault)}`;
  const target = `gui/${service.uid}/${label}`;
  const pair = await openCoordinatorPair(vault);
  let active: HomeLifecycleSuspension;
  let recovered = false;
  try {
    // Tx1 owns the lifecycle seam before observing any mutable evidence.
    await beginImmediate(pair.ownership);
    validateOwnershipRow(pair.ownership);
    const existing = readActive(pair.journal, vault);
    if (existing === null) {
      const evidence = await captureEvidence(vault, service.launchAgentsDir, deps);
      const priorLoaded = await isLoaded(service.launchctl, target);
      const now = exactTimestamp((deps.now ?? (() => new Date()))());
      active = Object.freeze({
        schema: HOME_LIFECYCLE_SUSPENSION_SCHEMA,
        phase: "suspending",
        purpose: input.purpose,
        operationId: requestedOperationId,
        vault,
        priorLoaded,
        ...evidence,
        requestedAt: now,
        phaseChangedAt: now,
        lastError: null,
      });
      writeJournal(pair.journal, () => insertActive(pair.journal, active));
    } else {
      if (!input.recoverExisting) {
        throw new Error(`Home lifecycle is suspended by ${existing.purpose}:${existing.operationId}`);
      }
      validateRecoveryOwner(existing, input.purpose, requestedOperationId);
      const evidence = await captureEvidence(vault, service.launchAgentsDir, deps);
      if (!sameEvidence(existing, evidence)) {
        throw new Error("Home installation or plist evidence changed since suspension");
      }
      active = existing;
      recovered = true;
    }
    pair.ownership.run("COMMIT");

    // Tx2 is live serialization. Durable journal commits do not release it.
    await beginImmediate(pair.ownership);
    validateOwnershipRow(pair.ownership);
    active = requireSameActive(pair.journal, vault, active);
    const execution = await runOwnedSuspension({
      pair,
      active,
      recovered,
      label,
      target,
      service,
      deps,
      operation,
    });
    pair.ownership.run("COMMIT");

    if (execution.operationError !== null) {
      if (execution.result.kind === "ready" || execution.result.kind === "not-required") {
        throw execution.operationError;
      }
      throw new AggregateError(
        [execution.operationError, new Error(resultFailure(execution.result))],
        "suspended operation failed and Dome Home could not resume",
      );
    }
    return execution.result;
  } catch (error) {
    rollback(pair.ownership);
    throw error;
  } finally {
    closePair(pair);
  }
}

async function runOwnedSuspension<T>(input: {
  readonly pair: CoordinatorPair;
  readonly active: HomeLifecycleSuspension;
  readonly recovered: boolean;
  readonly label: string;
  readonly target: string;
  readonly service: ReturnType<typeof resolveServiceDeps>;
  readonly deps: HomeLifecycleSuspensionDeps;
  readonly operation: () => Promise<T>;
}): Promise<{ readonly result: SupervisedHomeSuspensionResult<T>; readonly operationError: unknown | null }> {
  let active = input.active;
  let operationRan = false;
  let value: T | undefined;
  let operationError: unknown | null = null;

  if (active.phase !== "resuming") {
    if (await isLoaded(input.service.launchctl, input.target)) {
      const bootout = await input.service.launchctl(["bootout", input.target]);
      if (bootout.exitCode !== 0) {
        const error = `launchctl bootout failed: ${launchctlDetail(bootout)}`;
        persistError(input.pair.journal, active.operationId, error);
        return { result: failed(active, input.recovered, false, error), operationError };
      }
    }
    const drained = await waitForLaunchAgentDrain({
      launchctl: input.service.launchctl,
      uid: input.service.uid!,
      label: input.label,
      timeoutMs: input.service.drainTimeoutMs,
    });
    if (!drained) {
      const error = "Dome Home did not stop before the launchd drain timeout";
      persistError(input.pair.journal, active.operationId, error);
      return { result: failed(active, input.recovered, false, error), operationError };
    }
    if (active.phase === "suspending") {
      active = transition(input.pair.journal, active, "suspended", null, input.deps);
    }
    const evidence = await captureEvidence(active.vault, input.service.launchAgentsDir, input.deps);
    if (!sameEvidence(active, evidence)) {
      const error = "Home installation or plist evidence changed while suspended";
      persistError(input.pair.journal, active.operationId, error);
      return { result: failed(active, input.recovered, false, error), operationError };
    }
    operationRan = true;
    try { value = await input.operation(); }
    catch (error) { operationError = error; }
    try {
      active = transition(input.pair.journal, active, "resuming", operationError === null ? null : message(operationError), input.deps);
    } catch (transitionError) {
      if (operationError !== null) {
        throw new AggregateError(
          [operationError, transitionError],
          "suspended operation failed and its resuming phase could not be persisted",
        );
      }
      throw transitionError;
    }
  }

  let result: SupervisedHomeSuspensionResult<T>;
  try {
    result = await resumeOwned<T>({
      active,
      recovered: input.recovered,
      operationRan,
      value,
      service: input.service,
      label: input.label,
      target: input.target,
      journal: input.pair.journal,
      deps: input.deps,
    });
  } catch (resumeError) {
    const detail = `Dome Home resume failed: ${message(resumeError)}`;
    persistError(input.pair.journal, active.operationId, detail);
    result = Object.freeze({
      ...resultBase(active, input.recovered, operationRan, value),
      kind: "failed" as const,
      error: detail,
    });
  }
  return { result, operationError };
}

async function resumeOwned<T>(input: {
  readonly active: HomeLifecycleSuspension;
  readonly recovered: boolean;
  readonly operationRan: boolean;
  readonly value: T | undefined;
  readonly service: ReturnType<typeof resolveServiceDeps>;
  readonly label: string;
  readonly target: string;
  readonly journal: Database;
  readonly deps: HomeLifecycleSuspensionDeps;
}): Promise<SupervisedHomeSuspensionResult<T>> {
  const base = resultBase(input.active, input.recovered, input.operationRan, input.value);
  if (!input.active.priorLoaded) {
    clearActive(input.journal, input.active.operationId);
    return Object.freeze({ ...base, kind: "not-required" as const });
  }

  let admission;
  try { admission = await inspectOperationalWriterBarrier(input.active.vault); }
  catch (error) {
    const detail = `cannot inspect operational write admission: ${message(error)}`;
    persistError(input.journal, input.active.operationId, detail);
    return Object.freeze({ ...base, kind: "failed" as const, error: detail });
  }
  if (admission.blocked) {
    const transactionId = admission.transactionId ?? "unknown";
    persistError(input.journal, input.active.operationId, `operational write admission is closed by ${transactionId}`);
    return Object.freeze({ ...base, kind: "deferred" as const, reason: "write-barrier-closed" as const, transactionId });
  }

  let evidence: Evidence;
  try { evidence = await captureEvidence(input.active.vault, input.service.launchAgentsDir, input.deps); }
  catch (error) {
    const detail = message(error);
    persistError(input.journal, input.active.operationId, detail);
    return Object.freeze({ ...base, kind: "failed" as const, error: detail });
  }
  if (!sameEvidence(input.active, evidence)) {
    const error = "Home installation or plist evidence changed while suspended";
    persistError(input.journal, input.active.operationId, error);
    return Object.freeze({ ...base, kind: "failed" as const, error });
  }

  if (!await isLoaded(input.service.launchctl, input.target)) {
    const activation = await activateLaunchAgent({
      launchctl: input.service.launchctl,
      uid: input.service.uid!,
      label: input.label,
      plistPath: input.active.plistPath,
    });
    if (activation !== null) {
      persistError(input.journal, input.active.operationId, activation);
      return Object.freeze({ ...base, kind: "failed" as const, error: activation });
    }
  }
  if (!await waitForReadiness(input.deps)) {
    const error = "Dome Home restarted but did not become pairing-ready";
    persistError(input.journal, input.active.operationId, error);
    return Object.freeze({ ...base, kind: "failed" as const, error });
  }
  clearActive(input.journal, input.active.operationId);
  return Object.freeze({ ...base, kind: "ready" as const });
}

function resultBase<T>(active: HomeLifecycleSuspension, recovered: boolean, operationRan: boolean, value: T | undefined): SuspensionResultBase<T> {
  return Object.freeze({
    operationId: active.operationId,
    recovered,
    operationRan,
    ...(operationRan ? { value: value as T } : {}),
  });
}

function failed<T>(active: HomeLifecycleSuspension, recovered: boolean, operationRan: boolean, error: string): SupervisedHomeSuspensionResult<T> {
  return Object.freeze({ ...resultBase<T>(active, recovered, operationRan, undefined), kind: "failed" as const, error });
}

function resultFailure<T>(result: SupervisedHomeSuspensionResult<T>): string {
  return result.kind === "deferred"
    ? `operational write admission is closed by ${result.transactionId}`
    : result.kind === "failed" ? result.error : "Dome Home resume failed";
}

type CoordinatorPair = { readonly ownership: Database; readonly journal: Database };

async function openCoordinatorPair(vault: string): Promise<CoordinatorPair> {
  const paths = coordinatorPaths(vault);
  ensureCoordinatorLayout(vault);
  const ownership = await openOrInitialize(paths.ownership, OWNERSHIP_DDL, (db) => {
    db.query(`INSERT INTO ${OWNERSHIP_TABLE} (singleton, schema) VALUES (1, ?)`).run(OWNERSHIP_SCHEMA);
  }, validateOwnershipRow);
  try {
    const journal = await openOrInitialize(paths.journal, JOURNAL_DDL, () => {}, () => {});
    return Object.freeze({ ownership, journal });
  } catch (error) {
    ownership.close();
    throw error;
  }
}

function closePair(pair: CoordinatorPair): void {
  pair.journal.close();
  pair.ownership.close();
}

function coordinatorPaths(vault: string): { readonly journal: string; readonly ownership: string } {
  const locks = join(vault, ".dome", "state", "locks");
  return Object.freeze({ journal: join(locks, JOURNAL_NAME), ownership: join(locks, OWNERSHIP_NAME) });
}

function ensureCoordinatorLayout(vault: string): void {
  const dome = join(vault, ".dome");
  const state = join(dome, "state");
  const locks = join(state, "locks");
  ensureDirectDirectory(dome, false);
  ensureDirectDirectory(state, false);
  ensureDirectDirectory(locks, true);
}

function ensureDirectDirectory(path: string, privateDirectory: boolean): void {
  let created = false;
  try { mkdirSync(path, { mode: privateDirectory ? 0o700 : 0o755 }); created = true; }
  catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== resolve(path)) {
    throw new Error(`Home lifecycle suspension path is not a direct directory: ${path}`);
  }
  if (privateDirectory && (info.mode & 0o077) !== 0) {
    if (!created) throw new Error(`Home lifecycle suspension directory is not private: ${path}`);
    chmodSync(path, 0o700);
  }
  if (created) {
    fsyncPath(path);
    fsyncPath(dirname(path));
  }
}

async function openOrInitialize(
  path: string,
  ddl: string,
  seed: (db: Database) => void,
  validateRows: (db: Database) => void,
): Promise<Database> {
  const started = Date.now();
  for (;;) {
    try { return openOrInitializeOnce(path, ddl, seed, validateRows); }
    catch (error) {
      if (!isBusy(error) || Date.now() - started >= OWNERSHIP_WAIT_MS) throw error;
      await Bun.sleep(10);
    }
  }
}

function openOrInitializeOnce(path: string, ddl: string, seed: (db: Database) => void, validateRows: (db: Database) => void): Database {
  ensureCoordinatorFile(path);
  const before = lstatSync(path);
  const initializationCandidate = before.size === 0;
  const db = new Database(path);
  try {
    const after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("Home lifecycle coordinator changed while opening");
    configureConnection(db, initializationCandidate);
    let initialized = false;
    if (readSchema(db).length === 0) {
      db.run("BEGIN EXCLUSIVE");
      try {
        if (readSchema(db).length === 0) {
          db.run(ddl);
          seed(db);
          initialized = true;
        }
        db.run("COMMIT");
      } catch (error) {
        rollback(db);
        throw error;
      }
    }
    validateDatabase(db, ddl);
    validateRows(db);
    if (initialized) {
      fsyncPath(path);
      fsyncPath(dirname(path));
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function openEstablished(path: string, ddl: string, validateRows: (db: Database) => void): Database {
  const db = new Database(path, { readonly: true, create: false });
  try {
    configureConnection(db, false);
    validateDatabase(db, ddl);
    validateRows(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function configureConnection(db: Database, initializing: boolean): void {
  db.run(`PRAGMA busy_timeout = ${BUSY_SLICE_MS}`);
  const journal = initializing
    ? db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = DELETE").get()
    : db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  if (journal?.journal_mode.toLowerCase() !== "delete") {
    throw new Error("Home lifecycle coordinator must use DELETE journal mode");
  }
  const locking = db.query<{ locking_mode: string }, []>("PRAGMA locking_mode").get();
  if (locking?.locking_mode.toLowerCase() !== "normal") {
    throw new Error("Home lifecycle coordinator must use NORMAL locking mode");
  }
  db.run("PRAGMA synchronous = FULL");
  if (db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous !== 2) {
    throw new Error("Home lifecycle coordinator must use FULL synchronous mode");
  }
}

function validateDatabase(db: Database, ddl: string): void {
  const schema = readSchema(db);
  const row = schema[0];
  if (schema.length !== 1 || row === undefined || row.type !== "table" || row.sql === null || compactSql(row.sql) !== compactSql(ddl)) {
    throw new Error("Home lifecycle coordinator has an unknown schema layout");
  }
  const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error("Home lifecycle coordinator failed integrity_check");
  }
}

function readSchema(db: Database): ReadonlyArray<{ readonly type: string; readonly name: string; readonly sql: string | null }> {
  return db.query<{ type: string; name: string; sql: string | null }, []>(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all();
}

function validateOwnershipRow(db: Database): void {
  const rows = db.query<{ singleton: number; schema: string }, []>(`SELECT singleton, schema FROM ${OWNERSHIP_TABLE}`).all();
  if (rows.length !== 1 || rows[0]?.singleton !== 1 || rows[0]?.schema !== OWNERSHIP_SCHEMA) {
    throw new Error("Home lifecycle ownership singleton is invalid");
  }
}

function readActive(db: Database, vault: string): HomeLifecycleSuspension | null {
  const rows = db.query<JournalRow, []>(`SELECT * FROM ${JOURNAL_TABLE}`).all();
  if (rows.length === 0) return null;
  const row = rows[0];
  if (rows.length !== 1 || row === undefined || row.singleton !== 1 ||
    row.schema !== HOME_LIFECYCLE_SUSPENSION_SCHEMA ||
    !phase(row.phase) || (row.purpose !== "backup" && row.purpose !== "upgrade") ||
    !OPERATION_ID.test(row.operation_id) || row.vault !== vault ||
    (row.prior_loaded !== 0 && row.prior_loaded !== 1) ||
    !absoluteDirectEvidencePath(row.installation_path) || !absoluteDirectEvidencePath(row.plist_path) ||
    !SHA256.test(row.installation_sha256) || !SHA256.test(row.artifact_id) || !SHA256.test(row.plist_sha256) ||
    row.artifact_version.length === 0 || row.artifact_version.length > 1024 ||
    !isExactTimestamp(row.requested_at) || !isExactTimestamp(row.phase_changed_at) ||
    (row.last_error !== null && (row.last_error.length === 0 || row.last_error.length > 4096))) {
    throw new Error("Home lifecycle suspension active row is invalid");
  }
  return Object.freeze({
    schema: HOME_LIFECYCLE_SUSPENSION_SCHEMA,
    phase: row.phase,
    purpose: row.purpose,
    operationId: row.operation_id,
    vault: row.vault,
    priorLoaded: row.prior_loaded === 1,
    installationPath: row.installation_path,
    installationSha256: row.installation_sha256,
    artifactId: row.artifact_id,
    artifactVersion: row.artifact_version,
    plistPath: row.plist_path,
    plistSha256: row.plist_sha256,
    requestedAt: row.requested_at,
    phaseChangedAt: row.phase_changed_at,
    lastError: row.last_error,
  });
}

function insertActive(db: Database, row: HomeLifecycleSuspension): void {
  db.query(`INSERT INTO ${JOURNAL_TABLE} (
    singleton, schema, phase, purpose, operation_id, vault, prior_loaded,
    installation_path, installation_sha256, artifact_id, artifact_version,
    plist_path, plist_sha256, requested_at, phase_changed_at, last_error
  ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.schema, row.phase, row.purpose, row.operationId, row.vault,
    row.priorLoaded ? 1 : 0, row.installationPath, row.installationSha256,
    row.artifactId, row.artifactVersion, row.plistPath, row.plistSha256,
    row.requestedAt, row.phaseChangedAt, row.lastError,
  );
}

function transition(db: Database, row: HomeLifecycleSuspension, next: HomeSuspensionPhase, error: string | null, deps: HomeLifecycleSuspensionDeps): HomeLifecycleSuspension {
  const changedAt = exactTimestamp((deps.now ?? (() => new Date()))());
  writeJournal(db, () => {
    const changed = db.query(
      `UPDATE ${JOURNAL_TABLE} SET phase = ?, phase_changed_at = ?, last_error = ?
       WHERE singleton = 1 AND operation_id = ? AND phase = ?`,
    ).run(next, changedAt, boundedError(error), row.operationId, row.phase).changes;
    if (changed !== 1) throw new Error("Home lifecycle suspension phase changed concurrently");
  });
  return Object.freeze({ ...row, phase: next, phaseChangedAt: changedAt, lastError: boundedError(error) });
}

function persistError(db: Database, operationId: string, error: string): void {
  writeJournal(db, () => {
    if (db.query(`UPDATE ${JOURNAL_TABLE} SET last_error = ? WHERE singleton = 1 AND operation_id = ?`)
      .run(boundedError(error), operationId).changes !== 1) {
      throw new Error("Home lifecycle suspension ownership changed while recording failure");
    }
  });
}

function clearActive(db: Database, operationId: string): void {
  writeJournal(db, () => {
    if (db.query(`DELETE FROM ${JOURNAL_TABLE} WHERE singleton = 1 AND operation_id = ?`).run(operationId).changes !== 1) {
      throw new Error("Home lifecycle suspension ownership changed while clearing readiness");
    }
  });
}

function writeJournal(db: Database, operation: () => void): void {
  db.run("BEGIN IMMEDIATE");
  try {
    operation();
    db.run("COMMIT");
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function requireSameActive(db: Database, vault: string, expected: HomeLifecycleSuspension): HomeLifecycleSuspension {
  const current = readActive(db, vault);
  if (current === null || current.operationId !== expected.operationId || current.purpose !== expected.purpose || !sameEvidence(current, expected)) {
    throw new Error("Home lifecycle suspension ownership changed before Tx2");
  }
  return current;
}

function validateRecoveryOwner(active: HomeLifecycleSuspension, purpose: HomeSuspensionPurpose, requestedOperationId: string): void {
  if (active.purpose !== purpose) throw new Error(`Home lifecycle is suspended by ${active.purpose}:${active.operationId}`);
  if (purpose === "upgrade" && active.operationId !== requestedOperationId) {
    throw new Error(`upgrade suspension belongs to operation ${active.operationId}`);
  }
}

async function captureEvidence(vault: string, launchAgentsDir: string, deps: HomeInstallationDeps): Promise<Evidence> {
  const installation = await readHomeInstallation(vault, deps);
  if (installation === null) throw new Error("Dome Home must be installed before lifecycle suspension");
  const installationPath = homeInstallationPaths(vault, deps).record;
  const plistPath = join(launchAgentsDir, `com.dome.home.${vaultServiceSlug(vault)}.plist`);
  const installationBytes = await readStrictEvidence(installationPath, "installation");
  const plistBytes = await readStrictEvidence(plistPath, "plist");
  return Object.freeze({
    installationPath,
    installationSha256: hash(installationBytes),
    artifactId: installation.artifact.id,
    artifactVersion: installation.artifact.version,
    plistPath,
    plistSha256: hash(plistBytes),
  });
}

async function readStrictEvidence(path: string, label: string): Promise<Uint8Array> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024 || realpathSync(path) !== resolve(path)) {
    throw new Error(`Dome Home ${label} evidence is not a direct bounded regular file`);
  }
  return readFile(path);
}

function sameEvidence(left: Evidence, right: Evidence): boolean {
  return left.installationPath === right.installationPath &&
    left.installationSha256 === right.installationSha256 &&
    left.artifactId === right.artifactId &&
    left.artifactVersion === right.artifactVersion &&
    left.plistPath === right.plistPath &&
    left.plistSha256 === right.plistSha256;
}

async function isLoaded(launchctl: ReturnType<typeof resolveServiceDeps>["launchctl"], target: string): Promise<boolean> {
  return (await launchctl(["print", target])).exitCode === 0;
}

async function waitForReadiness(deps: HomeLifecycleSuspensionDeps): Promise<boolean> {
  const deadline = Date.now() + (deps.readinessTimeoutMs ?? 10_000);
  do {
    try {
      if (deps.readiness !== undefined
        ? await deps.readiness()
        : await isStrictPairingReadiness(await fetch("http://127.0.0.1:3663/pair/status"))) return true;
    } catch { /* retry until bounded timeout */ }
    if (Date.now() >= deadline) return false;
    await Bun.sleep(200);
  } while (true);
}

async function isStrictPairingReadiness(response: Response): Promise<boolean> {
  if (response.status !== 200) return false;
  try {
    const value = await response.json() as { readonly schema?: unknown; readonly available?: unknown; readonly paired?: unknown };
    return value.schema === "dome.device.pairing/v1" && value.available === true && typeof value.paired === "boolean";
  } catch { return false; }
}

function ensureCoordinatorFile(path: string): void {
  let created = false;
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollowFlag(), 0o600);
    closeSync(fd);
    created = true;
  } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  if (created) chmodSync(path, 0o600);
  validateExistingCoordinatorFile(path, "coordinator");
  if (created) {
    fsyncPath(path);
    fsyncPath(dirname(path));
  }
}

function validateExistingCoordinatorFile(path: string, label: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
    (info.mode & 0o777) !== 0o600 || realpathSync(path) !== resolve(path)) {
    throw new Error(`Home lifecycle ${label} must be a direct private regular file`);
  }
}

async function beginImmediate(db: Database): Promise<void> {
  const started = Date.now();
  for (;;) {
    try { db.run("BEGIN IMMEDIATE"); return; }
    catch (error) {
      if (!isBusy(error) || Date.now() - started >= OWNERSHIP_WAIT_MS) throw error;
      await Bun.sleep(10);
    }
  }
}

function rollback(db: Database): void { try { db.run("ROLLBACK"); } catch {} }
function canonicalVault(path: string): string { return realpathSync(resolve(path)); }
function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function phase(value: string): value is HomeSuspensionPhase { return value === "suspending" || value === "suspended" || value === "resuming"; }
function absoluteDirectEvidencePath(value: string): boolean { return value.length > 0 && value === resolve(value); }
function exactTimestamp(value: Date): string { const timestamp = value.toISOString(); if (!isExactTimestamp(timestamp)) throw new Error("timestamp is invalid"); return timestamp; }
function isExactTimestamp(value: string): boolean { const time = Date.parse(value); return Number.isFinite(time) && new Date(time).toISOString() === value; }
function compactSql(value: string): string { return value.replace(/\s+/g, " ").trim().replace(/;$/, ""); }
function boundedError(value: string | null): string | null { return value === null ? null : value.slice(0, 4096) || "unknown failure"; }
function launchctlDetail(result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string }): string { return result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function assertOperationId(value: string): void { if (!OPERATION_ID.test(value)) throw new Error("Home suspension operation id is invalid"); }
function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code; }
function isBusy(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "SQLITE_BUSY"; }
function noFollowFlag(): number { return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0; }
function fsyncPath(path: string): void { const fd = openSync(path, constants.O_RDONLY | noFollowFlag()); try { fsyncSync(fd); } finally { closeSync(fd); } }
