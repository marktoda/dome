// AC1 + AC3 + AC6 end-to-end sanity:
//   `dome init` -> openVault -> write a wiki page -> drain hooks ->
//   verify index.md + log.md grew -> `dome doctor` exits 0.
//
// This pins the v0.5 acceptance criteria: a vault bootstrap is real, the
// shipped-default hooks actually wire (auto-update-index + EVERY_WRITE_IS_LOGGED),
// and `dome doctor` reports clean on the resulting tree.

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domeInit } from "../../src/cli/commands/init";
import { domeDoctor } from "../../src/cli/commands/doctor";
import { openVault } from "../../src/vault";

describe("end-to-end: init -> open -> write -> drain -> doctor", () => {
  test("dome init produces a working vault that survives a write + doctor pass", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-e2e-"));
    const vaultPath = join(base, "vault");
    try {
      // 1. Bootstrap
      const initRes = await domeInit(vaultPath);
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;
      expect(existsSync(join(vaultPath, ".dome", "config.yaml"))).toBe(true);
      expect(existsSync(join(vaultPath, ".dome", "hooks", "intake-raw.yaml"))).toBe(true);
      expect(existsSync(join(vaultPath, "inbox", "raw"))).toBe(true);
      expect(existsSync(join(vaultPath, ".git"))).toBe(true);

      // 2. Open the vault.
      const openRes = await openVault(vaultPath);
      expect(openRes.ok).toBe(true);
      if (!openRes.ok) return;
      const vault = openRes.value;

      // 3. Write a wiki/entities page through the bound tool surface.
      const writeRes = await vault.tools.writeDocument({
        path: "wiki/entities/atlas.md",
        body: "# Atlas\n\nA test entity for the end-to-end pass.",
        frontmatter: {
          type: "entity",
          created: "2026-05-25",
          updated: "2026-05-25",
          sources: [],
        },
        opts: { create: true, reason: "named_explicitly" },
      });
      expect(writeRes.result.ok).toBe(true);

      // 4. Drain async hooks (auto-update-index, auto-cross-reference are async).
      await vault.drainHooks();

      // 5. AC: index.md got an entry (auto-update-index fired).
      const indexContent = await readFile(join(vaultPath, "index.md"), "utf8");
      expect(indexContent).toContain("[[wiki/entities/atlas]]");

      // 6. AC: log.md got an entry (EVERY_WRITE_IS_LOGGED).
      const logContent = await readFile(join(vaultPath, "log.md"), "utf8");
      // The bootstrap commit already wrote one line; after the write we expect
      // at least one more `## [ts] update | ...` entry.
      const logEntries = logContent.match(/^## \[/gm) ?? [];
      expect(logEntries.length).toBeGreaterThanOrEqual(2);

      // 7. AC6: dome doctor on a clean vault exits 0.
      const doctorRes = await domeDoctor(vaultPath);
      expect(doctorRes.ok).toBe(true);
      if (!doctorRes.ok) return;
      expect(doctorRes.value.exitCode).toBe(0);
      expect(doctorRes.value.violations).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
