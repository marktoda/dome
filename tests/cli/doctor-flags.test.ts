import { describe, test, expect } from "bun:test";
import { writeFile, utimes, readFile, rm } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { domeDoctor } from "../../src/cli/commands/doctor";
import { domeInit } from "../../src/cli/commands/init";
import { makeTestVault } from "../helpers/make-test-vault";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("dome doctor flags (formerly no-op)", () => {
  test("--recent-activity walks log.md and prints the last N entries", async () => {
    const v = await makeTestVault();
    try {
      const log = [
        "# Log",
        "",
        "## [2026-05-25T10:00:00Z] bootstrap | initialize vault",
        "",
        "## [2026-05-25T11:00:00Z] ingest | wiki/entities/alice.md",
        "",
        "## [2026-05-25T12:00:00Z] update | wiki/entities/bob.md",
        "",
      ].join("\n");
      await Bun.write(`${v.path}/log.md`, log);

      const r = await domeDoctor(v.path, { recentActivityN: 2 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const activityLines = r.value.info.filter(l => l.startsWith("recent:"));
      expect(activityLines.length).toBe(2);
      expect(activityLines[1]).toContain("update | wiki/entities/bob.md");
      expect(activityLines[0]).toContain("ingest | wiki/entities/alice.md");
    } finally {
      await v.cleanup();
    }
  });

  test("--drain-hooks calls vault.drainHooks() and exits clean", async () => {
    const v = await makeTestVault();
    try {
      const r = await domeDoctor(v.path, { drainHooks: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.exitCode).toBe(0);
      // Info should mention the drain happened, NOT that it was a no-op.
      const drainInfo = r.value.info.find(l => l.startsWith("--drain-hooks:"));
      expect(drainInfo).toBeDefined();
      expect(drainInfo).not.toContain("no-op");
      expect(drainInfo).toContain("drained");
    } finally {
      await v.cleanup();
    }
  });

  test("flags inbox files older than hooks.inbox_stale_age_hours; excludes inbox/review/", async () => {
    const v = await makeTestVault();
    try {
      const { writeFile, utimes, mkdir } = await import("node:fs/promises");
      await mkdir(`${v.path}/inbox/raw`, { recursive: true });
      await mkdir(`${v.path}/inbox/review`, { recursive: true });

      // Stale file in inbox/raw/ — should be flagged.
      const stalePath = `${v.path}/inbox/raw/stale.md`;
      await writeFile(stalePath, "old");
      const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago
      await utimes(stalePath, longAgo, longAgo);

      // Stale file in inbox/review/ — should NOT be flagged (review is a destination).
      const reviewPath = `${v.path}/inbox/review/old-review-item.md`;
      await writeFile(reviewPath, "old review");
      await utimes(reviewPath, longAgo, longAgo);

      const r = await domeDoctor(v.path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const inboxViolations = r.value.violations.filter(v => v.includes("inbox/"));
      expect(inboxViolations.some(v => v.includes("inbox/raw/stale.md"))).toBe(true);
      expect(inboxViolations.some(v => v.includes("inbox/review/"))).toBe(false);
    } finally {
      await v.cleanup();
    }
  });

  test("--reset-quarantined-hooks empties .dome/state/quarantined.json", async () => {
    const v = await makeTestVault();
    try {
      const { writeFile, readFile, mkdir } = await import("node:fs/promises");
      const stateDir = `${v.path}/.dome/state`;
      await mkdir(stateDir, { recursive: true });
      await writeFile(`${stateDir}/quarantined.json`, JSON.stringify(["bad-handler-1", "bad-handler-2"]));

      const r = await domeDoctor(v.path, { resetQuarantinedHooks: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const data = JSON.parse(await readFile(`${stateDir}/quarantined.json`, "utf8")) as string[];
      expect(data).toEqual([]);
      const resetInfo = r.value.info.find(l => l.startsWith("--reset-quarantined-hooks:"));
      expect(resetInfo).toContain("cleared");
      expect(resetInfo).not.toContain("no-op");
    } finally {
      await v.cleanup();
    }
  });

  test("--show recent-hook-cycles parses hook.cycle-detected entries from log.md", async () => {
    const v = await makeTestVault();
    try {
      const log = [
        "# Log",
        "",
        "## [2026-05-25T10:00:00Z] hook.cycle-detected | handler=auto-cross-reference depth=51",
        "",
        "## [2026-05-25T10:05:00Z] ingest | wiki/entities/alice.md",
        "",
        "## [2026-05-25T11:00:00Z] hook.cycle-detected | handler=user-hook depth=5",
        "",
      ].join("\n");
      await Bun.write(`${v.path}/log.md`, log);

      const r = await domeDoctor(v.path, { showRecentHookCycles: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const cycleLines = r.value.info.filter(l => l.startsWith("hook-cycle:"));
      expect(cycleLines.length).toBe(2);
      expect(cycleLines[0]).toContain("auto-cross-reference");
      expect(cycleLines[1]).toContain("user-hook");
    } finally {
      await v.cleanup();
    }
  });

  test("--show raw-citations groups wiki pages by the raw source they cite", async () => {
    const v = await makeTestVault();
    try {
      await Bun.write(`${v.path}/raw/2026-05-25-alice-meeting.md`, "---\nid: raw_alice\n---\n");
      const wikiFm = (sources: string) =>
        `---\ntype: entity\ncreated: 2026-05-25\nupdated: 2026-05-25\nsources: ${sources}\n---\n# X\n`;
      await Bun.write(
        `${v.path}/wiki/entities/alice.md`,
        wikiFm(`["[[raw/2026-05-25-alice-meeting]]"]`),
      );
      await Bun.write(
        `${v.path}/wiki/entities/bob.md`,
        wikiFm(`["[[raw/2026-05-25-alice-meeting]]"]`),
      );

      const r = await domeDoctor(v.path, { showRawCitations: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const citationLines = r.value.info.filter(l => l.startsWith("raw-citation:"));
      const aliceLine = citationLines.find(l => l.includes("alice-meeting"));
      expect(aliceLine).toBeDefined();
      expect(aliceLine!).toContain("wiki/entities/alice.md");
      expect(aliceLine!).toContain("wiki/entities/bob.md");
    } finally {
      await v.cleanup();
    }
  });

  test("--show review-queue lists files in inbox/review/", async () => {
    const v = await makeTestVault();
    try {
      await Bun.write(`${v.path}/inbox/review/item-a.md`, "# A\n");
      await Bun.write(`${v.path}/inbox/review/item-b.md`, "# B\n");

      const r = await domeDoctor(v.path, { showReviewQueue: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const queueLines = r.value.info.filter(l => l.startsWith("review-queue:"));
      expect(queueLines.length).toBe(2);
      expect(queueLines.some(l => l.includes("item-a.md"))).toBe(true);
      expect(queueLines.some(l => l.includes("item-b.md"))).toBe(true);
    } finally {
      await v.cleanup();
    }
  });

  test("--time-since-reconcile reports drift age based on last-reconciled-sha.txt mtime", async () => {
    const v = await makeTestVault();
    try {
      const reconcilePath = join(v.path, ".dome", "state", "last-reconciled-sha.txt");
      await mkdir(join(v.path, ".dome", "state"), { recursive: true });
      await writeFile(reconcilePath, "abc123");
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(reconcilePath, twoHoursAgo, twoHoursAgo);

      const r = await domeDoctor(v.path, { timeSinceReconcile: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const summary = r.value.info.find(s => s.startsWith("time-since-reconcile:"));
      expect(summary).toBeDefined();
      expect(summary!).toMatch(/2 hours?/);
    } finally {
      await v.cleanup();
    }
  });

  test("--time-since-reconcile reports 'never' when last-reconciled-sha.txt is absent", async () => {
    const v = await makeTestVault();
    try {
      const r = await domeDoctor(v.path, { timeSinceReconcile: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const summary = r.value.info.find(s => s.startsWith("time-since-reconcile:"));
      expect(summary).toBeDefined();
      expect(summary!.toLowerCase()).toContain("never");
    } finally {
      await v.cleanup();
    }
  });

  test("--repair regenerates AGENTS.md templated section while preserving user-prose", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-repair-"));
    const target = join(base, "v");
    try {
      await domeInit(target);
      const agentsPath = join(target, "AGENTS.md");

      const original = await readFile(agentsPath, "utf8");
      const customProse = "\n## My naming conventions\n\nProjects use `proj-` prefix.\n\n";
      const withProse = original.replace(
        /<!-- BEGIN user-prose -->\n\n<!-- END user-prose -->/,
        `<!-- BEGIN user-prose -->${customProse}<!-- END user-prose -->`,
      );
      await writeFile(agentsPath, withProse);

      const res = await domeDoctor(target, { repair: true });
      expect(res.ok).toBe(true);

      const after = await readFile(agentsPath, "utf8");
      expect(after).toContain(customProse);
      expect(after).toContain("EVERY_WRITE_IS_LOGGED");
      expect(after).toContain("<!-- BEGIN user-prose -->");
      expect(after).toContain("<!-- END user-prose -->");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("--repair recreates AGENTS.md when missing entirely", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-repair-missing-"));
    const target = join(base, "v");
    try {
      await domeInit(target);
      const agentsPath = join(target, "AGENTS.md");
      await rm(agentsPath);

      const res = await domeDoctor(target, { repair: true });
      expect(res.ok).toBe(true);
      expect(existsSync(agentsPath)).toBe(true);

      const after = await readFile(agentsPath, "utf8");
      expect(after).toContain("<!-- BEGIN user-prose -->");
      expect(after).toContain("<!-- END user-prose -->");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
