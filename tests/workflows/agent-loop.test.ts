import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { runWorkflow } from "../../src/workflows/agent-loop";
import { projectAiSdk } from "../../src/workflows/project-ai-sdk";
import { filterAiTools } from "../../src/tools/ai-sdk-binding";
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

  test("filterAiTools includes only the workflow's declared tool subset", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const tools = filterAiTools(projectAiSdk(res.value), [
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

  // WORKFLOWS_KNOW_VAULT_CONTEXT structural seam: situational context lives
  // in SDK partials composed via `{{include}}`, replacing the v0.5.0
  // code-driven preamble registry. The split between system-base and
  // per-workflow inclusion is load-bearing — see the test below.
  test("system-base.md includes vault-identity (universal) but NOT rendering-surface (workflow-only)", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const loader = new PromptLoader(res.value);
      const base = await loader.load("system-base");
      expect(base).not.toBeNull();
      // vault-identity IS in system-base — universal across every surface
      // that loads system-base (workflow runs AND MCP `instructions`).
      expect(base!.body).toContain(v.path);
      // rendering-surface is NOT in system-base. Otherwise MCP `instructions`
      // (delivered to interactive Claude Code sessions) would carry
      // "non-interactive single-turn" framing that misleads the client.
      // Workflow prompts include rendering-surface directly; see the
      // per-workflow assertion in tests/prompts/extension-points.test.ts.
      expect(base!.body.toLowerCase()).not.toContain("non-interactive");
      expect(base!.body).not.toContain("# Rendering surface");
      // The directives themselves should have resolved, not appear as raw text.
      expect(base!.body).not.toContain("{{include: preamble-vault-identity.md}}");
      expect(base!.body).not.toContain("{{vault.path}}");
    } finally {
      await v.cleanup();
    }
  });

  // The corollary: a workflow's resolved body MUST carry rendering-surface
  // (since workflow runs are non-interactive and the LLM needs that framing).
  test("resolved workflow body carries the rendering-surface preamble (via per-workflow include)", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const loader = new PromptLoader(res.value);
      for (const name of ["ingest", "query", "lint"] as const) {
        const p = await loader.load(name);
        expect(p).not.toBeNull();
        expect(p!.body.toLowerCase()).toContain("non-interactive");
        expect(p!.body).toContain("# Rendering surface");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("filterAiTools silently drops unknown tool names", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const tools = filterAiTools(projectAiSdk(res.value), ["readDocument", "doesNotExist"]);
      expect(Object.keys(tools)).toEqual(["readDocument"]);
    } finally {
      await v.cleanup();
    }
  });
});
