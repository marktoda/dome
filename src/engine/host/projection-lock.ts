// engine/host/projection-lock: shared exclusion for projection.db writes.
//
// Projection rows are rebuildable, but rebuild is a semantic reset/repopulate
// sequence. Normal adoption/garden/view writes must not interleave with that
// reset, so every engine path that writes projection.db uses this lock.

import { join } from "node:path";

import { withExclusiveFileLock } from "./file-lock";

const PROJECTION_WRITE_LOCK_TIMEOUT_MS = 60_000;
const PROJECTION_WRITE_LOCK_INTERVAL_MS = 50;

export async function withProjectionWriteLock<T>(
  opts: {
    readonly vaultPath: string;
    readonly command: string;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = projectionWriteLockPath(opts.vaultPath);
  const locked = await withExclusiveFileLock(
    {
      lockPath,
      command: opts.command,
      wait: {
        timeoutMs: PROJECTION_WRITE_LOCK_TIMEOUT_MS,
        intervalMs: PROJECTION_WRITE_LOCK_INTERVAL_MS,
      },
    },
    fn,
  );
  if (locked.kind === "acquired") return locked.value;

  throw new Error(
    "projection write lock busy after " +
      `${PROJECTION_WRITE_LOCK_TIMEOUT_MS}ms at ${locked.lockPath}`,
  );
}

export function projectionWriteLockPath(vaultPath: string): string {
  return join(vaultPath, ".dome", "state", "locks", "projection-write.lock");
}
