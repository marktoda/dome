// A probation candidate must not create the vault-local Product Host lock,
// because that would mutate the rollback snapshot it is validating. Every new
// normal host takes this same external lock before its legacy vault-local lock,
// so the two modes still exclude one another across processes.

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  withExclusiveFileLock,
  type FileLockResult,
} from "../engine/host/file-lock";

/** Input is the one canonical vault path resolved by startProductHost. */
export function externalProductHostLockPath(vaultPath: string): string {
  const key = createHash("sha256").update(vaultPath, "utf8").digest("hex");
  return join(tmpdir(), "dome-product-host-locks", `${key}.lock`);
}

/** Normal Home takes both locks in one fixed order; busy at either is busy. */
export async function withProductHostOwnership<T>(
  vaultPath: string,
  operation: () => Promise<T>,
): Promise<FileLockResult<T>> {
  const external = await withExclusiveFileLock(
    {
      lockPath: externalProductHostLockPath(vaultPath),
      command: "dome-product-host",
    },
    () => withExclusiveFileLock(
      {
        lockPath: join(vaultPath, ".dome", "state", "locks", "product-host.lock"),
        command: "dome-product-host",
      },
      operation,
    ),
  );
  return external.kind === "busy" ? external : external.value;
}
