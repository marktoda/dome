// Tests for `dome stats`. See src/cli/commands/stats.ts and
// docs/superpowers/specs/2026-05-26-dome-stats-design.md.

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { domeInit } from "../../src/cli/commands/init";
import { openVault } from "../../src/vault";
import { collectStats, renderJson, renderDashboard, domeStats, type VaultStats } from "../../src/cli/commands/stats";
import { runCli, ExitCode } from "../../src/cli/cli";

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

  test("renderJson round-trips through JSON.parse", async () => {
    const v = await makeStatsVault();
    try {
      const vaultRes = await openVault(v.path);
      if (!vaultRes.ok) throw new Error("openVault failed");
      const stats = await collectStats(vaultRes.value);
      const json = renderJson(stats);
      const parsed = JSON.parse(json);
      expect(parsed).toEqual(stats);
    } finally {
      await v.cleanup();
    }
  });

  function stripAnsi(s: string): string {
    // Match CSI escape sequences.
    return s.replace(/\x1b\[[0-9;]*m/g, "");
  }

  test("renderDashboard contains the vault path, DOME header, and headline numbers", async () => {
    const v = await makeStatsVault();
    try {
      await writeFile(
        join(v.path, "wiki", "entities", "alice.md"),
        "---\ntype: entity\n---\n# Alice\n",
      );
      const vaultRes = await openVault(v.path);
      if (!vaultRes.ok) throw new Error("openVault failed");
      const stats = await collectStats(vaultRes.value);
      const out = stripAnsi(renderDashboard(stats));

      expect(out).toContain("DOME");
      expect(out).toContain(v.path);
      expect(out).toContain("pages");
      expect(out).toContain("Wikilinks");
      expect(out).toContain("Raw files");
      expect(out).toContain("Log");
      expect(out).toContain("Vault age");
      expect(out).toMatch(/\b1\b/); // 1 entity page exists
    } finally {
      await v.cleanup();
    }
  });

  test("renderDashboard formats last-write age relative to lastWriteAt", async () => {
    // Hand-craft a VaultStats — no need for a real vault.
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    const stats: VaultStats = {
      vaultPath: "/tmp/v",
      pageCounts: {},
      totalPages: 0,
      wikilinks: { total: 0, orphans: 0 },
      raw: { count: 0, bytes: 0 },
      notes: { count: 0 },
      log: { entries: 1, lastWriteAt: recent },
      topHubs: [],
      git: { ageDays: 0, commits: 1, contributors: 1 },
    };
    const out = stripAnsi(renderDashboard(stats));
    expect(out).toMatch(/last: 2h ago/);
  });

  test("renderDashboard renders bytes with KB/MB suffix", async () => {
    const stats: VaultStats = {
      vaultPath: "/tmp/v",
      pageCounts: {},
      totalPages: 0,
      wikilinks: { total: 0, orphans: 0 },
      raw: { count: 3, bytes: 2_500_000 }, // ~2.4 MB
      notes: { count: 0 },
      log: { entries: 0, lastWriteAt: null },
      topHubs: [],
      git: { ageDays: 0, commits: 0, contributors: 0 },
    };
    const out = stripAnsi(renderDashboard(stats));
    expect(out).toMatch(/2\.4 MB/);
  });

  test("renderDashboard emits no ANSI when picocolors detects no color support", async () => {
    // picocolors honors NO_COLOR / FORCE_COLOR / !isTTY. Bun tests run with
    // stdout piped (not a TTY), so picocolors.isColorSupported should be false
    // by default and no escape codes should appear.
    const stats: VaultStats = {
      vaultPath: "/tmp/v",
      pageCounts: { entity: 1 },
      totalPages: 1,
      wikilinks: { total: 0, orphans: 0 },
      raw: { count: 0, bytes: 0 },
      notes: { count: 0 },
      log: { entries: 0, lastWriteAt: null },
      topHubs: [],
      git: { ageDays: 0, commits: 0, contributors: 0 },
    };
    const out = renderDashboard(stats);
    expect(out).not.toMatch(/\x1b\[/);
  });

  test("domeStats returns dashboard output for an existing vault", async () => {
    const v = await makeStatsVault();
    try {
      const r = await domeStats(v.path, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.output).toContain("DOME");
      expect(r.value.output).toContain(v.path);
    } finally {
      await v.cleanup();
    }
  });

  test("domeStats with --json returns JSON output", async () => {
    const v = await makeStatsVault();
    try {
      const r = await domeStats(v.path, { json: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const parsed = JSON.parse(r.value.output);
      expect(parsed.vaultPath).toBe(v.path);
      expect(typeof parsed.totalPages).toBe("number");
    } finally {
      await v.cleanup();
    }
  });

  test("domeStats returns err when vault path is not a vault", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-stats-novault-"));
    try {
      const r = await domeStats(base, {});
      expect(r.ok).toBe(false);
      if (r.ok) return;
      // Any vault-open error kind is acceptable; the orchestrator just forwards.
      expect(typeof r.error.kind).toBe("string");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("runCli stats --vault exits Success on a real vault", async () => {
    const v = await makeStatsVault();
    try {
      // Exit code matters for plumbing; the dashboard output is already
      // covered by the renderDashboard / renderJson unit tests above.
      const code = await runCli(["stats", "--vault", v.path]);
      expect(code).toBe(ExitCode.Success);
      const codeJson = await runCli(["stats", "--vault", v.path, "--json"]);
      expect(codeJson).toBe(ExitCode.Success);
    } finally {
      await v.cleanup();
    }
  });

  test("runCli stats --help exits Success", async () => {
    const code = await runCli(["stats", "--help"]);
    expect(code).toBe(ExitCode.Success);
  });

  test("runCli stats on a non-vault path exits Failure", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-stats-cli-novault-"));
    try {
      const code = await runCli(["stats", "--vault", base]);
      expect(code).toBe(ExitCode.Failure);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("renderDashboard shows `+N more types` footer when more than 5 page types are present", () => {
    // Hand-craft VaultStats with 7 non-zero page types.
    const stats: VaultStats = {
      vaultPath: "/tmp/v",
      pageCounts: {
        entity: 10, concept: 8, spec: 6, invariant: 5, matrix: 4, gotcha: 3, source: 2,
      },
      totalPages: 38,
      wikilinks: { total: 0, orphans: 0 },
      raw: { count: 0, bytes: 0 },
      notes: { count: 0 },
      log: { entries: 0, lastWriteAt: null },
      topHubs: [],
      git: { ageDays: 0, commits: 0, contributors: 0 },
    };
    const out = stripAnsi(renderDashboard(stats));
    // 7 nonzero types - top 5 shown = +2 more.
    expect(out).toMatch(/\+2 more types/);
  });

  test("renderDashboard omits `+N more types` when 5 or fewer page types present", () => {
    const stats: VaultStats = {
      vaultPath: "/tmp/v",
      pageCounts: { entity: 3, concept: 2 },
      totalPages: 5,
      wikilinks: { total: 0, orphans: 0 },
      raw: { count: 0, bytes: 0 },
      notes: { count: 0 },
      log: { entries: 0, lastWriteAt: null },
      topHubs: [],
      git: { ageDays: 0, commits: 0, contributors: 0 },
    };
    const out = stripAnsi(renderDashboard(stats));
    expect(out).not.toMatch(/more types/);
  });
});
