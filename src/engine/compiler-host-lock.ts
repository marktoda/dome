// engine/compiler-host-lock: per-branch runtime host exclusion.
//
// The compiler host can be entered by several surfaces (`serve`, `sync`, the
// harness, and future local servers). This file owns the small process-level
// lock that keeps those surfaces from running adoption or operational patch
// work concurrently for the same source branch.

import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";

// ----- Public types ---------------------------------------------------------

export type CompilerHostLockHolder = {
  readonly pid: number | null;
  readonly hostname: string | null;
  readonly command: string | null;
  readonly acquiredAt: string | null;
};

export type CompilerHostLockBusy = {
  readonly kind: "busy";
  readonly branch: string;
  readonly lockPath: string;
  readonly holder: CompilerHostLockHolder | null;
};

export type CompilerHostLockResult<T> =
  | { readonly kind: "acquired"; readonly value: T }
  | CompilerHostLockBusy;

// ----- withCompilerHostBranchLock ------------------------------------------

export async function withCompilerHostBranchLock<T>(
  opts: {
    readonly vaultPath: string;
    readonly branch: string;
    readonly command: string;
  },
  fn: () => Promise<T>,
): Promise<CompilerHostLockResult<T>> {
  const lockPath = compilerHostLockPath(opts.vaultPath, opts.branch);
  const token = randomUUID();
  const acquired = await tryAcquireLock({
    lockPath,
    branch: opts.branch,
    command: opts.command,
    token,
  });
  if (acquired.kind === "busy") return acquired;

  try {
    return Object.freeze({
      kind: "acquired" as const,
      value: await fn(),
    });
  } finally {
    await releaseLockIfOwner(lockPath, token);
  }
}

export function compilerHostLockPath(
  vaultPath: string,
  branch: string,
): string {
  return join(
    vaultPath,
    ".dome",
    "state",
    "locks",
    `${encodeBranchForFilename(branch)}.compiler-host.lock`,
  );
}

// ----- internals ------------------------------------------------------------

type LockFile = CompilerHostLockHolder & {
  readonly branch: string;
  readonly token: string;
};

async function tryAcquireLock(opts: {
  readonly lockPath: string;
  readonly branch: string;
  readonly command: string;
  readonly token: string;
}): Promise<{ readonly kind: "acquired" } | CompilerHostLockBusy> {
  await mkdir(dirname(opts.lockPath), { recursive: true });
  const payload: LockFile = {
    branch: opts.branch,
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
    branch: opts.branch,
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
): Promise<CompilerHostLockHolder | null> {
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
      branch: typeof parsed.branch === "string" ? parsed.branch : "",
      token: typeof parsed.token === "string" ? parsed.token : "",
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : null,
      command: typeof parsed.command === "string" ? parsed.command : null,
      acquiredAt:
        typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : null,
    });
  } catch {
    return null;
  }
}

function isDefinitelyStale(holder: CompilerHostLockHolder): boolean {
  if (holder.hostname === null) return true;
  if (holder.hostname !== hostname()) return false;
  if (holder.pid === null) return true;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function encodeBranchForFilename(branch: string): string {
  return Buffer.from(branch, "utf8").toString("base64url");
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
