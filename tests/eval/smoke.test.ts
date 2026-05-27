import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { makeFixtureVault } from "../../src/eval/fixture-vault";
import { openVault } from "../../src/vault";
import { runWorkflow } from "../../src/workflows/agent-loop";

// A no-op mock model: drives the AI SDK loop end-to-end without contacting
// a real provider. Mirrors the pattern in tests/workflows/agent-loop.test.ts.
function makeNoopMockModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

describe("eval fixture vault", () => {
  test("makeFixtureVault produces a working git-backed vault", async () => {
    const fx = await makeFixtureVault({
      files: {
        "wiki/entities/test.md": "---\ntype: entity\n---\n# Test",
      },
    });
    try {
      const res = await openVault(fx.path);
      expect(res.ok).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  test("replay smoke: query workflow runs against MockLanguageModelV3 over a fixture vault (AC4)", async () => {
    const fx = await makeFixtureVault({
      files: {
        "wiki/entities/atlas.md": "---\ntype: entity\n---\n# Atlas\n\nAtlas is a test fixture.",
        "wiki/concepts/cohesion.md": "---\ntype: concept\n---\n# Cohesion",
      },
    });
    try {
      const res = await openVault(fx.path);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const mock = makeNoopMockModel();
      const result = await runWorkflow(
        res.value,
        "query",
        "What do I know about Atlas?",
        { model: mock },
      );

      // The SDK drove a single generate call and stopped (no tool calls).
      expect(mock.doGenerateCalls.length).toBe(1);
      expect(result.finishReason).toBe("stop");
      expect(result.steps).toBe(1);
      expect(result.toolCallCount).toBe(0);

      // The workflow body landed in system; the user message landed in prompt.
      const call = mock.doGenerateCalls[0]!;
      const systemMsg = call.prompt.find((m) => m.role === "system");
      expect(systemMsg).toBeDefined();
      const userMsg = call.prompt.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
    } finally {
      await fx.cleanup();
    }
  });
});
