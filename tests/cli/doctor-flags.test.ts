import { describe, test, expect } from "bun:test";
import { domeDoctor } from "../../src/cli/commands/doctor";
import { makeTestVault } from "../helpers/make-test-vault";

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
});
