// Tests for `dome stats`. See src/cli/commands/stats.ts and
// docs/superpowers/specs/2026-05-26-dome-stats-design.md.

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { domeInit } from "../../src/cli/commands/init";
import { openVault } from "../../src/vault";
import { collectStats, renderJson, renderDashboard, domeStats } from "../../src/cli/commands/stats";

async function makeStatsVault(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "dome-stats-"));
  const target = join(base, "v");
  await domeInit(target);
  return {
    path: target,
    cleanup: async () => { await rm(base, { recursive: true, force: true }); },
  };
}

describe("dome stats", () => {
  test("smoke: collectStats returns a VaultStats shape on a fresh init", async () => {
    const v = await makeStatsVault();
    try {
      const vaultRes = await openVault(v.path);
      expect(vaultRes.ok).toBe(true);
      if (!vaultRes.ok) return;
      const stats = await collectStats(vaultRes.value);
      expect(stats.vaultPath).toBe(v.path);
      expect(stats.totalPages).toBe(0);
    } finally {
      await v.cleanup();
    }
  });
});
