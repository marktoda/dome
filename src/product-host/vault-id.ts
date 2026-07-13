// Stable, opaque Product Host identity stored in gitignored operational state.

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function ensureVaultId(vaultPath: string): Promise<string> {
  const path = join(vaultPath, ".dome", "state", "product-host-id");
  try {
    const current = (await readFile(path, "utf8")).trim();
    if (current.length > 0) return current;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const created = randomUUID();
  try {
    await writeFile(path, `${created}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return created;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    return (await readFile(path, "utf8")).trim();
  }
}

/** Read the existing stable id without creating or repairing any state. */
export async function readVaultId(vaultPath: string): Promise<string> {
  const path = join(vaultPath, ".dome", "state", "product-host-id");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) {
    throw new Error("Product Host vault identity is not a bounded regular file");
  }
  const id = (await readFile(path, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error("Product Host vault identity is missing or malformed");
  }
  return id;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
