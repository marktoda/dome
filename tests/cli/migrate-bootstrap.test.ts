// Blocker 3: dome migrate against a directory that is NOT yet a Dome vault.
// Before this fix, openVault required .dome/config.yaml and returned
// config-invalid before the migrate workflow could run. Now domeMigrate
// scaffolds the .dome/ surface in-place if absent.
//
// Uses MockLanguageModelV3 via opts.model (per-test, no module mocking) so
// the test doesn't bleed across files in the same Bun process.

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domeMigrate } from "../../src/cli/commands/migrate";

function makeNoopMockModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "migration plan written" }],
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

describe("dome migrate bootstraps .dome/ before opening", () => {
  test("scaffolds a non-Dome markdown directory and reaches the migrate workflow", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-migrate-bootstrap-"));
    const vaultPath = join(base, "obsidian-vault");
    try {
      // Simulate an existing markdown vault (no .dome/, no .git/, just user content).
      await mkdir(vaultPath, { recursive: true });
      await mkdir(join(vaultPath, "notes"), { recursive: true });
      await writeFile(join(vaultPath, "notes", "existing.md"), "# Old note\n\n[[bare-link]]");

      const res = await domeMigrate(vaultPath, false, { model: makeNoopMockModel(), skipCommit: true });
      expect(res.ok).toBe(true);

      // The bootstrap happened: .dome/config.yaml + .git/ now exist.
      expect(existsSync(join(vaultPath, ".dome", "config.yaml"))).toBe(true);
      expect(existsSync(join(vaultPath, ".dome", "page-types.yaml"))).toBe(true);
      expect(existsSync(join(vaultPath, ".git"))).toBe(true);

      // Existing user content untouched.
      expect(existsSync(join(vaultPath, "notes", "existing.md"))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("returns a clean validation error when path doesn't exist", async () => {
    const res = await domeMigrate("/nonexistent-vault-path-xyz", false, {
      model: makeNoopMockModel(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe("validation");
    }
  });
});
