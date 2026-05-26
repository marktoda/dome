import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { runWorkflow, buildAiSdkTools } from "../../src/workflows/agent-loop";
import { PromptLoader } from "../../src/prompts/prompt-loader";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";
import { WorkflowName } from "../../src/workflows/workflow-name";

// Minimal "no-op" mock model: returns a single text-only step with finishReason
// "stop". The SDK still drives the generation pipeline (system prompt
// assembly, tool plumbing) which is the seam we're testing — we just don't
// actually want to call Anthropic.
function makeNoopMockModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: {
        unified: "stop",
        raw: "end_turn",
      },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

describe("runWorkflow", () => {
  test("throws when workflow is not found", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      await expect(
        runWorkflow(res.value, "nonexistent" as never, "x", { model: makeNoopMockModel() }),
      ).rejects.toThrow(/workflow not found/);
    } finally {
      await v.cleanup();
    }
  });

  test("resolves workflow body + tools and drives the SDK to a stop", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const mock = makeNoopMockModel();
      const result = await runWorkflow(
        res.value,
        WorkflowName.Query,
        "What do I know about Atlas?",
        { model: mock },
      );

      // We made one model call (no tool calls -> immediate stop).
      expect(mock.doGenerateCalls.length).toBe(1);
      const call = mock.doGenerateCalls[0]!;

      // System prompt is the workflow body, not the user message.
      const systemMsg = call.prompt.find((m) => m.role === "system");
      expect(systemMsg).toBeDefined();
      const systemText = systemMsg!.role === "system" ? systemMsg!.content : "";
      expect(systemText).toContain("Query");

      // User message lands in the prompt.
      const userMsg = call.prompt.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();

      // Only the query workflow's declared tool subset is exposed.
      const toolNames = (call.tools ?? []).map((t) => t.name).sort();
      expect(toolNames).toEqual(
        ["readDocument", "searchIndex", "wikilinkResolve", "writeDocument"].sort(),
      );

      expect(result.finishReason).toBe("stop");
      expect(result.toolCallCount).toBe(0);
      expect(result.steps).toBe(1);
    } finally {
      await v.cleanup();
    }
  });

  test("buildAiSdkTools includes only the workflow's declared tool subset", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      // sensitivity-classify only exposes 3 tools.
      const tools = buildAiSdkTools(res.value, [
        "readDocument",
        "writeDocument",
        "appendLog",
      ]);
      expect(Object.keys(tools).sort()).toEqual(
        ["appendLog", "readDocument", "writeDocument"].sort(),
      );
    } finally {
      await v.cleanup();
    }
  });

  // WORKFLOWS_KNOW_VAULT_CONTEXT: every workflow's system prompt is
  // prepended with preambles that name vault.path AND describe the
  // rendering surface. Without these, prompts that say "convert the
  // directory" or "walk the vault" have no anchor for which vault they
  // mean, and the LLM hallucinates a conversational shell — addressing
  // the user with phrases like "say apply the plan" that don't apply in
  // a non-interactive CLI invocation.
  test("prepends a vault-identity preamble naming vault.path to the system prompt", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const mock = makeNoopMockModel();
      await runWorkflow(res.value, WorkflowName.Lint, "", { model: mock });

      const call = mock.doGenerateCalls[0]!;
      const systemMsg = call.prompt.find((m) => m.role === "system");
      expect(systemMsg).toBeDefined();
      const systemText = systemMsg!.role === "system" ? systemMsg!.content : "";
      // Preamble carries vault.path so every workflow knows its target.
      expect(systemText).toContain(v.path);
      // Workflow body still follows the preambles.
      expect(systemText).toContain("Lint");
    } finally {
      await v.cleanup();
    }
  });

  test("prepends a rendering-surface preamble describing non-interactive single-turn semantics", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const mock = makeNoopMockModel();
      await runWorkflow(res.value, WorkflowName.Lint, "", { model: mock });

      const call = mock.doGenerateCalls[0]!;
      const systemMsg = call.prompt.find((m) => m.role === "system");
      const systemText = systemMsg!.role === "system" ? systemMsg!.content : "";
      // The rendering-surface preamble tells the LLM its reply is the
      // workflow's final output, that there's no conversational
      // follow-up channel, and that next-step guidance should name the
      // next CLI command rather than address a shell.
      expect(systemText.toLowerCase()).toContain("non-interactive");
      expect(systemText.toLowerCase()).toContain("cli");
    } finally {
      await v.cleanup();
    }
  });

  test("substitutes a synthetic kickoff for empty userMessage (API rejects empty content blocks)", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const mock = makeNoopMockModel();
      await runWorkflow(res.value, WorkflowName.Lint, "", { model: mock });

      const call = mock.doGenerateCalls[0]!;
      const userMsg = call.prompt.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      const content = userMsg!.role === "user" ? userMsg!.content : [];
      const textParts = Array.isArray(content)
        ? content.filter((p): p is { type: "text"; text: string } => p.type === "text")
        : [];
      const joined = textParts.map((p) => p.text).join("");
      expect(joined.length).toBeGreaterThan(0);
    } finally {
      await v.cleanup();
    }
  });

  // WORKFLOWS_KNOW_VAULT_CONTEXT structural seam: instead of a code-driven
  // preamble registry (the v0.5.0 mechanism), the situational context lives
  // in two SDK partials (`preamble-vault-identity.md`, `preamble-rendering-surface.md`)
  // included at the top of `system-base.md`. The `{{vault.path}}` substitution
  // in PromptLoader is what makes the identity partial vault-specific.
  test("system-base.md includes both situational preambles via {{include}} slots", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const loader = new PromptLoader(res.value);
      const base = await loader.load("system-base");
      expect(base).not.toBeNull();
      // Both situational preambles are inlined into the resolved body.
      expect(base!.body).toContain(v.path); // vault-identity (via {{vault.path}})
      expect(base!.body.toLowerCase()).toContain("non-interactive"); // rendering-surface
      // The directives themselves should have resolved, not appear as raw text.
      expect(base!.body).not.toContain("{{include: preamble-vault-identity.md}}");
      expect(base!.body).not.toContain("{{include: preamble-rendering-surface.md}}");
      expect(base!.body).not.toContain("{{vault.path}}");
    } finally {
      await v.cleanup();
    }
  });

  test("buildAiSdkTools silently drops unknown tool names", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const tools = buildAiSdkTools(res.value, ["readDocument", "doesNotExist"]);
      expect(Object.keys(tools)).toEqual(["readDocument"]);
    } finally {
      await v.cleanup();
    }
  });
});
