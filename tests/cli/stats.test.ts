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

  test("wiki walk: pageCounts, totalPages, wikilinks, topHubs", async () => {
    const v = await makeStatsVault();
    try {
      await writeFile(
        join(v.path, "wiki", "entities", "alice.md"),
        "---\ntype: entity\n---\n# Alice\n\nKnows [[wiki/entities/bob]] and [[wiki/entities/bob]] and [[wiki/entities/carol]].",
      );
      await writeFile(
        join(v.path, "wiki", "entities", "bob.md"),
        "---\ntype: entity\n---\n# Bob\n\nKnows [[wiki/entities/carol]].",
      );
      await writeFile(
        join(v.path, "wiki", "entities", "carol.md"),
        "---\ntype: entity\n---\n# Carol\n\nMentions [[wiki/entities/ghost]].",
      );
      await writeFile(
        join(v.path, "wiki", "concepts", "trust.md"),
        "---\ntype: concept\n---\n# Trust\n\nSee [[wiki/entities/alice]].",
      );
      await writeFile(
        join(v.path, "wiki", "concepts", "memory.md"),
        "---\ntype: concept\n---\n# Memory\n",
      );

      const vaultRes = await openVault(v.path);
      if (!vaultRes.ok) throw new Error("openVault failed");
      const stats = await collectStats(vaultRes.value);

      expect(stats.totalPages).toBe(5);
      expect(stats.pageCounts.entity).toBe(3);
      expect(stats.pageCounts.concept).toBe(2);
      expect(stats.wikilinks.total).toBe(6);
      expect(stats.wikilinks.orphans).toBe(1);
      // bob and carol tie at incoming=2; alice is third at incoming=1.
      const top2Targets = new Set(stats.topHubs.slice(0, 2).map(h => h.target));
      expect(top2Targets).toEqual(new Set(["wiki/entities/bob.md", "wiki/entities/carol.md"]));
      expect(stats.topHubs.slice(0, 2).every(h => h.incoming === 2)).toBe(true);
      expect(stats.topHubs[2]).toEqual({ target: "wiki/entities/alice.md", incoming: 1 });
    } finally {
      await v.cleanup();
    }
  });

  test("raw + notes: count and bytes", async () => {
    const v = await makeStatsVault();
    try {
      // dome init does NOT create notes/; create it explicitly.
      await mkdir(join(v.path, "notes"), { recursive: true });
      await writeFile(join(v.path, "raw", "first.md"), "raw one body");      // 12 bytes
      await writeFile(join(v.path, "raw", "second.md"), "raw two body here"); // 17 bytes
      await writeFile(join(v.path, "notes", "scratch.md"), "scratch");

      const vaultRes = await openVault(v.path);
      if (!vaultRes.ok) throw new Error("openVault failed");
      const stats = await collectStats(vaultRes.value);

      expect(stats.raw.count).toBe(2);
      expect(stats.raw.bytes).toBe(29); // 12 + 17
      expect(stats.notes.count).toBe(1);
    } finally {
      await v.cleanup();
    }
  });

  test("log: entries count and lastWriteAt", async () => {
    const v = await makeStatsVault();
    try {
      // dome init wrote one bootstrap entry. Append two more with timestamps in the future.
      const logPath = join(v.path, "log.md");
      const existing = await Bun.file(logPath).text();
      const ts1 = "2027-01-01T10:00:00Z"; // Far in future to ensure it's after bootstrap
      const ts2 = "2027-01-01T11:00:00Z";
      const appended = existing +
        `\n## [${ts1}] update | thing one\n\nBody.\n` +
        `\n## [${ts2}] update | thing two\n\nBody.\n`;
      await writeFile(logPath, appended);

      const vaultRes = await openVault(v.path);
      if (!vaultRes.ok) throw new Error("openVault failed");
      const stats = await collectStats(vaultRes.value);

      expect(stats.log.entries).toBeGreaterThanOrEqual(3); // bootstrap + 2 appended
      expect(stats.log.lastWriteAt).toBe(ts2); // The most recent timestamp (lexicographically largest)
    } finally {
      await v.cleanup();
    }
  });

  test("git: ageDays, commits, contributors on a fresh init", async () => {
    const v = await makeStatsVault();
    try {
      const vaultRes = await openVault(v.path);
      if (!vaultRes.ok) throw new Error("openVault failed");
      const stats = await collectStats(vaultRes.value);

      // dome init creates exactly one commit, authored by the Dome author.
      expect(stats.git.commits).toBeGreaterThanOrEqual(1);
      expect(stats.git.contributors).toBeGreaterThanOrEqual(1);
      expect(stats.git.ageDays).not.toBeNull();
      expect(stats.git.ageDays).toBeGreaterThanOrEqual(0);
    } finally {
      await v.cleanup();
    }
  });
});
