// Blocker 3: dome migrate against a directory that is NOT yet a Dome vault.
// Before this fix, openVault required .dome/config.yaml and returned
// config-invalid before the migrate workflow could run. Now domeMigrate
// scaffolds the .dome/ surface in-place if absent.

import { describe, test, expect, mock, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domeMigrate } from "../../src/cli/commands/migrate";

// Capture runWorkflow without invoking the LLM. The migrate workflow's job
// is to reshape existing markdown; the assertion in this test is that we
// REACH the workflow at all, having bootstrapped .dome/ first.
const runCalls: { workflowName: string; userMessage: string }[] = [];

mock.module("../../src/workflows/agent-loop", () => ({
  runWorkflow: async (_vault: unknown, workflowName: string, userMessage: string) => {
    runCalls.push({ workflowName, userMessage });
    return { text: "migration plan written", steps: [], finishReason: { unified: "stop", raw: "stop" }, toolCallCount: 0 };
  },
  buildAiSdkTools: () => ({}),
  DEFAULT_MODEL: "claude-opus-4-7",
  DEFAULT_MAX_STEPS: 50,
}));

afterEach(() => { runCalls.length = 0; });

describe("dome migrate bootstraps .dome/ before opening", () => {
  test("scaffolds a non-Dome markdown directory and reaches the migrate workflow", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-migrate-bootstrap-"));
    const vaultPath = join(base, "obsidian-vault");
    try {
      // Simulate an existing markdown vault (no .dome/, no .git/, just user content).
      await mkdir(vaultPath, { recursive: true });
      await mkdir(join(vaultPath, "notes"), { recursive: true });
      await writeFile(join(vaultPath, "notes", "existing.md"), "# Old note\n\n[[bare-link]]");

      const res = await domeMigrate(vaultPath, false);
      expect(res.ok).toBe(true);

      // Verify the bootstrap: .dome/config.yaml + .git/ now exist.
      expect(existsSync(join(vaultPath, ".dome", "config.yaml"))).toBe(true);
      expect(existsSync(join(vaultPath, ".dome", "page-types.yaml"))).toBe(true);
      expect(existsSync(join(vaultPath, ".git"))).toBe(true);

      // Verify existing user content is left untouched.
      const stillThere = existsSync(join(vaultPath, "notes", "existing.md"));
      expect(stillThere).toBe(true);

      // Verify we actually reached the migrate workflow.
      expect(runCalls.length).toBe(1);
      expect(runCalls[0]!.workflowName).toBe("migrate");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("returns a clean validation error when path doesn't exist", async () => {
    const res = await domeMigrate("/nonexistent-vault-path-xyz", false);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe("validation");
    }
  });
});
