import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../..");

describe("capability policy document seam", () => {
  test("production callers resolve both policy documents instead of bypassing the seam", async () => {
    const sourceRoot = join(ROOT, "src");
    const offenders: string[] = [];
    for (const path of await typescriptFiles(sourceRoot)) {
      if (path.endsWith("/engine/core/capability-policy.ts")) continue;
      const body = await readFile(path, "utf8");
      if (/\bparseCapabilityPolicy\b/.test(body)) {
        offenders.push(relative(ROOT, path));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("operator surfaces do not hand-render runtime-open failures or raw policy errors", async () => {
    const sourceRoot = join(ROOT, "src");
    const offenders: string[] = [];
    for (const path of await typescriptFiles(sourceRoot)) {
      if (path.endsWith("/surface/adapter.ts")) continue;
      const body = await readFile(path, "utf8");
      if (
        /openVaultRuntime failed\s*\(/.test(body) ||
        /detail:\s*loaded\.error/.test(body)
      ) {
        offenders.push(relative(ROOT, path));
      }
    }
    expect(offenders).toEqual([]);
  });
});

async function typescriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await typescriptFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}
