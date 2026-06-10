// Vault-root discovery (src/surface/resolve-vault.ts): commands run from inside
// a vault subdirectory target the nearest ancestor with .dome/config.yaml.
// Before this, every handler used the bare cwd, so `dome status` from
// `<vault>/wiki/` failed with advice to `dome init` — which would have
// scaffolded a nested vault inside the real one.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveVaultPath } from "../../src/surface/resolve-vault";

const cleanups: Array<() => Promise<void>> = [];
const originalCwd = process.cwd();
afterEach(async () => {
  process.chdir(originalCwd);
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function makeVaultWithSubdir(): Promise<{
  vaultRoot: string;
  subdir: string;
}> {
  // realpath via resolve(mkdtemp): macOS tmpdir is a /var → /private/var
  // symlink; process.cwd() returns the resolved form, so compare resolved.
  const root = mkdtempSync(join(tmpdir(), "dome-resolve-vault-"));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const vaultRoot = join(root, "vault");
  const subdir = join(vaultRoot, "wiki", "concepts");
  await mkdir(subdir, { recursive: true });
  await mkdir(join(vaultRoot, ".dome"), { recursive: true });
  await writeFile(join(vaultRoot, ".dome", "config.yaml"), "extensions: {}\n");
  return { vaultRoot, subdir };
}

describe("resolveVaultPath", () => {
  test("an explicit --vault is used as given, no discovery", async () => {
    const { subdir } = await makeVaultWithSubdir();
    expect(resolveVaultPath(subdir)).toBe(resolve(subdir));
  });

  test("discovers the nearest ancestor vault from a subdirectory cwd", async () => {
    const { subdir } = await makeVaultWithSubdir();
    process.chdir(subdir);
    // Compare against the resolved cwd (macOS tmpdir is a symlink).
    const resolvedSubdir = process.cwd();
    const expectedRoot = resolvedSubdir.slice(
      0,
      -"/wiki/concepts".length,
    );
    expect(resolveVaultPath(undefined)).toBe(expectedRoot);
  });

  test("falls back to the cwd when no ancestor is a vault", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dome-no-vault-"));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    process.chdir(dir);
    expect(resolveVaultPath(undefined)).toBe(process.cwd());
  });

  test("the vault root itself resolves to itself", async () => {
    const { vaultRoot } = await makeVaultWithSubdir();
    process.chdir(vaultRoot);
    expect(resolveVaultPath(undefined)).toBe(process.cwd());
  });
});
