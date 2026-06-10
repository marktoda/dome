// engine/host/file-lock: small cross-process exclusive lock helper.
//
// The engine has a few local critical sections that span more than one SQLite
// statement or git operation. SQLite serializes individual writes, but it does
// not know that "drop every projection table, run processors, then stamp
// projection_meta" is one semantic rebuild. This helper provides the shared
// file-lock substrate for those host-level sections.

import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname } from "node:os";

export type FileLockHolder = {
  readonly pid: number | null;
  readonly hostname: string | null;
  readonly command: string | null;
  readonly acquiredAt: string | null;
};

export type FileLockBusy = {
  readonly kind: "busy";
  readonly lockPath: string;
  readonly holder: FileLockHolder | null;
};

export type FileLockResult<T> =
  | { readonly kind: "acquired"; readonly value: T }
  | FileLockBusy;

export type FileLockWait = {
  readonly timeoutMs: number;
  readonly intervalMs: number;
};

export async function withExclusiveFileLock<T>(
  opts: {
    readonly lockPath: string;
    readonly command: string;
    readonly wait?: FileLockWait;
  },
  fn: () => Promise<T>,
): Promise<FileLockResult<T>> {
  const token = randomUUID();
  const acquired = await acquireLock({
    lockPath: opts.lockPath,
    command: opts.command,
    token,
    ...(opts.wait !== undefined ? { wait: opts.wait } : {}),
  });
  if (acquired.kind === "busy") return acquired;

  try {
    return Object.freeze({
      kind: "acquired" as const,
      value: await fn(),
    });
  } finally {
    await releaseLockIfOwner(opts.lockPath, token);
  }
}

type LockFile = FileLockHolder & {
  readonly token: string;
};

const UNKNOWN_OR_MALFORMED_LOCK_STALE_MS = 5 * 60 * 1000;

async function acquireLock(opts: {
  readonly lockPath: string;
  readonly command: string;
  readonly token: string;
  readonly wait?: FileLockWait;
}): Promise<{ readonly kind: "acquired" } | FileLockBusy> {
  const started = Date.now();
  while (true) {
    const attempt = await tryAcquireOnce(opts);
    if (attempt.kind === "acquired") return attempt;

    const wait = opts.wait;
    if (wait === undefined) return attempt;

    const elapsed = Date.now() - started;
    const remaining = wait.timeoutMs - elapsed;
    if (remaining <= 0) return attempt;

    await sleep(Math.min(wait.intervalMs, remaining));
  }
}

async function tryAcquireOnce(opts: {
  readonly lockPath: string;
  readonly command: string;
  readonly token: string;
}): Promise<{ readonly kind: "acquired" } | FileLockBusy> {
  await mkdir(dirname(opts.lockPath), { recursive: true });
  const payload: LockFile = {
    token: opts.token,
    pid: process.pid,
    hostname: hostname(),
    command: opts.command,
    acquiredAt: new Date().toISOString(),
  };

  const first = await writeLockFile(opts.lockPath, payload);
  if (first) return Object.freeze({ kind: "acquired" as const });

  const holder = await readLockHolder(opts.lockPath);
  if (holder === null || isDefinitelyStale(holder)) {
    await unlinkIfExists(opts.lockPath);
    const second = await writeLockFile(opts.lockPath, payload);
    if (second) return Object.freeze({ kind: "acquired" as const });
  }

  return Object.freeze({
    kind: "busy" as const,
    lockPath: opts.lockPath,
    holder,
  });
}

async function writeLockFile(
  lockPath: string,
  payload: LockFile,
): Promise<boolean> {
  try {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
      return true;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  }
}

async function releaseLockIfOwner(
  lockPath: string,
  token: string,
): Promise<void> {
  const current = await readLockFile(lockPath);
  if (current?.token !== token) return;
  await unlinkIfExists(lockPath);
}

async function readLockHolder(
  lockPath: string,
): Promise<FileLockHolder | null> {
  const lock = await readLockFile(lockPath);
  if (lock === null) return null;
  return Object.freeze({
    pid: lock.pid,
    hostname: lock.hostname,
    command: lock.command,
    acquiredAt: lock.acquiredAt,
  });
}

async function readLockFile(lockPath: string): Promise<LockFile | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<LockFile>;
    return Object.freeze({
      token: typeof parsed.token === "string" ? parsed.token : "",
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : null,
      command: typeof parsed.command === "string" ? parsed.command : null,
      acquiredAt:
        typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : null,
    });
  } catch {
    let acquiredAt: string | null = null;
    try {
      acquiredAt = (await stat(lockPath)).mtime.toISOString();
    } catch {
      acquiredAt = null;
    }
    return Object.freeze({
      token: "",
      pid: null,
      hostname: null,
      command: "unparseable-lock",
      acquiredAt,
    });
  }
}

function isDefinitelyStale(holder: FileLockHolder): boolean {
  if (holder.hostname === null) {
    return lockTimestampIsStale(holder.acquiredAt);
  }
  if (holder.hostname !== hostname()) return false;
  if (holder.pid === null) return lockTimestampIsStale(holder.acquiredAt);
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch {
    return true;
  }
}

function lockTimestampIsStale(timestamp: string | null): boolean {
  if (timestamp === null) return false;
  const acquiredAtMs = Date.parse(timestamp);
  if (!Number.isFinite(acquiredAtMs)) return false;
  return Date.now() - acquiredAtMs > UNKNOWN_OR_MALFORMED_LOCK_STALE_MS;
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlreadyExists(error: unknown): boolean {
  return hasErrorCode(error, "EEXIST");
}

function isNotFound(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
