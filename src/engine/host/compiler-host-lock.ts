// engine/host/compiler-host-lock: per-branch runtime host exclusion.
//
// The compiler host can be entered by several surfaces (`serve`, `sync`, the
// harness, and future local servers). This file owns the branch-specific
// wrapper around the shared file-lock helper so adoption and operational patch
// work cannot race for the same source branch.

import { join } from "node:path";

import {
  withExclusiveFileLock,
  type FileLockHolder,
  type FileLockWait,
} from "./file-lock";

// ----- Public types ---------------------------------------------------------

export type CompilerHostLockHolder = FileLockHolder;

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
    readonly wait?: FileLockWait;
  },
  fn: () => Promise<T>,
): Promise<CompilerHostLockResult<T>> {
  const lockPath = compilerHostLockPath(opts.vaultPath, opts.branch);
  const locked = await withExclusiveFileLock(
    {
      lockPath,
      command: opts.command,
      ...(opts.wait !== undefined ? { wait: opts.wait } : {}),
    },
    fn,
  );
  if (locked.kind === "acquired") return locked;

  return Object.freeze({
    kind: "busy" as const,
    branch: opts.branch,
    lockPath,
    holder: locked.holder,
  });
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

function encodeBranchForFilename(branch: string): string {
  return Buffer.from(branch, "utf8").toString("base64url");
}
