import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { runWorkflow, buildAiSdkTools } from "../../src/workflows/agent-loop";
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
