import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { domeInit } from "../../src/cli/commands/init";
import { openVault } from "../../src/vault";

describe("dome init", () => {
  test("produces a working vault with intake-raw + inbox/raw/ + initial git commit", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-init-"));
    const target = join(base, "test-vault");
    try {
      const result = await domeInit(target);
      expect(result.ok).toBe(true);
      // Required artifacts
      expect(existsSync(join(target, ".dome", "config.yaml"))).toBe(true);
      expect(existsSync(join(target, ".dome", "hooks", "intake-raw.yaml"))).toBe(true);
      expect(existsSync(join(target, "inbox", "raw"))).toBe(true);
      expect(existsSync(join(target, "index.md"))).toBe(true);
      expect(existsSync(join(target, "log.md"))).toBe(true);
      expect(existsSync(join(target, ".git"))).toBe(true);
      // openVault succeeds
      const vault = await openVault(target);
      expect(vault.ok).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("refuses if .dome/ already exists", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-init-"));
    const target = join(base, "test-vault");
    try {
      await domeInit(target);
      const second = await domeInit(target);
      expect(second.ok).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
