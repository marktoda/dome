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

// Read system text and joined user text from a captured doGenerate call.
// User content is an array of parts (text / image / tool-result); we keep
// only the text parts so assertions can use substring matches.
function readMessages(call: { prompt: ReadonlyArray<{ role: string; content: unknown }> }): {
  system: string;
  user: string;
} {
  const sysMsg = call.prompt.find((m) => m.role === "system");
  const userMsg = call.prompt.find((m) => m.role === "user");
  const system = sysMsg && typeof sysMsg.content === "string" ? sysMsg.content : "";
  let user = "";
  if (userMsg && Array.isArray(userMsg.content)) {
    user = userMsg.content
      .filter(
        (p): p is { type: "text"; text: string } =>
          typeof p === "object" && p !== null && (p as { type: string }).type === "text",
      )
      .map((p) => p.text)
      .join("");
  }
  return { system, user };
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

  // Regression test for the bug where `dome migrate <path>` hit the LLM
  // with userMessage = "" (or "--apply") AND a system prompt that
  // referenced `<path>` as an unsubstituted placeholder. The agent had no
  // way to know which directory it was converting and dutifully asked the
  // user, completing in one step. This test pins the contract:
  //
  // - system prompt contains vault.path via the vault prologue
  //   (WORKFLOWS_KNOW_VAULT_CONTEXT)
  // - user message describes the task ("apply" vs "plan only") so
  //   subjectFromUserMessage produces a meaningful commit subject AND the
  //   LLM gets a clean kickoff turn rather than the synthetic "Begin."
  test("LLM receives vault.path in system prompt and a task description in the user message (dry-run)", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-migrate-msg-"));
    const vaultPath = join(base, "vault");
    try {
      await mkdir(vaultPath, { recursive: true });
      const mock = makeNoopMockModel();

      const res = await domeMigrate(vaultPath, false, { model: mock, skipCommit: true });
      expect(res.ok).toBe(true);

      expect(mock.doGenerateCalls.length).toBeGreaterThanOrEqual(1);
      const { system, user } = readMessages(mock.doGenerateCalls[0]!);

      expect(system).toContain(vaultPath);
      expect(user.toLowerCase()).toContain("plan");
      expect(user.toLowerCase()).not.toContain("--apply");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("--apply branch surfaces an execute-the-plan task in the user message", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-migrate-apply-"));
    const vaultPath = join(base, "vault");
    try {
      await mkdir(vaultPath, { recursive: true });
      const mock = makeNoopMockModel();

      const res = await domeMigrate(vaultPath, true, { model: mock, skipCommit: true });
      expect(res.ok).toBe(true);

      const { system, user } = readMessages(mock.doGenerateCalls[0]!);
      expect(system).toContain(vaultPath);
      expect(user.toLowerCase()).toContain("execute");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
