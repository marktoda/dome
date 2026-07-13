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

export type FileLockInspection =
  | { readonly kind: "absent" }
  | { readonly kind: "definitely-stale"; readonly holder: FileLockHolder }
  | { readonly kind: "possibly-live"; readonly holder: FileLockHolder | null };

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

/**
 * Read-only, conservative inspection for callers that cannot mutate a lock.
 * Only a well-formed same-host holder with a definitely dead PID is stale.
 * Malformed, remote-host, permission-denied, and ambiguous holders stay live.
 */
export async function inspectExclusiveFileLock(
  lockPath: string,
): Promise<FileLockInspection> {
  const lock = await readLockFile(lockPath);
  if (lock === null) return Object.freeze({ kind: "absent" as const });
  const wellFormed = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(lock.token) && lock.pid !== null && Number.isSafeInteger(lock.pid) && lock.pid > 0 &&
    lock.hostname !== null && lock.hostname.length > 0 &&
    lock.command !== null && lock.command.length > 0 &&
    lock.acquiredAt !== null && Number.isFinite(Date.parse(lock.acquiredAt));
  if (!wellFormed || lock.hostname !== hostname()) {
    return Object.freeze({ kind: "possibly-live" as const, holder: readOnlyHolder(lock) });
  }
  try {
    process.kill(lock.pid!, 0);
    return Object.freeze({ kind: "possibly-live" as const, holder: readOnlyHolder(lock) });
  } catch (error) {
    // EPERM means the process exists but is not signalable. Only ESRCH proves
    // the same-host PID no longer exists.
    if (hasErrorCode(error, "ESRCH")) {
      return Object.freeze({ kind: "definitely-stale" as const, holder: readOnlyHolder(lock) });
    }
    return Object.freeze({ kind: "possibly-live" as const, holder: readOnlyHolder(lock) });
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

  const judged = await readLockFile(opts.lockPath);
  if (judged === null || isDefinitelyStale(judged)) {
    const broke = await breakStaleLock(opts.lockPath, judged);
    const second = broke && (await writeLockFile(opts.lockPath, payload));
    if (second) {
      // Ownership verify: between our create and now, another contender
      // that judged the SAME prior holder stale may have unlinked our
      // fresh lock and written its own. Only the contender whose token
      // survives in the file actually holds the lock.
      const verified = await readLockFile(opts.lockPath);
      if (verified?.token === opts.token) {
        return Object.freeze({ kind: "acquired" as const });
      }
    }
  }

  return Object.freeze({
    kind: "busy" as const,
    lockPath: opts.lockPath,
    holder: await readLockHolder(opts.lockPath),
  });
}

/**
 * Compare-then-unlink for a lock previously judged stale. POSIX has no
 * atomic compare-and-delete for plain files, so the takeover protocol
 * narrows the race twice: (1) here — re-read immediately before unlinking
 * and abort unless the file still carries the judged-stale content, so a
 * fresh lock written by a faster contender is never unlinked; (2) in the
 * caller — verify token ownership after the create. Returns true when the
 * path is clear for a create attempt.
 */
async function breakStaleLock(
  lockPath: string,
  judged: LockFile | null,
): Promise<boolean> {
  const current = await readLockFile(lockPath);
  // Released (or already broken) since we looked: clear to attempt create.
  if (current === null) return true;
  if (
    judged === null ||
    current.token !== judged.token ||
    current.acquiredAt !== judged.acquiredAt
  ) {
    // The lock changed hands since we judged it stale; the new holder is
    // presumed live. Do not unlink what we did not judge.
    return false;
  }
  await unlinkIfExists(lockPath);
  return true;
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

function readOnlyHolder(lock: LockFile): FileLockHolder {
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
