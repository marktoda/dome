import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domeInit } from "../../src/cli/commands/init";
import { domeLint } from "../../src/cli/commands/lint";

function makeNoopMockModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "lint complete" }],
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

function readUserMessage(call: { prompt: ReadonlyArray<{ role: string; content: unknown }> }): string {
  const userMsg = call.prompt.find((m) => m.role === "user");
  if (!userMsg || !Array.isArray(userMsg.content)) return "";
  return userMsg.content
    .filter(
      (p): p is { type: "text"; text: string } =>
        typeof p === "object" && p !== null && (p as { type: string }).type === "text",
    )
    .map((p) => p.text)
    .join("");
}

describe("dome lint two-mode invocation", () => {
  test("apply mode with one id sends 'apply H1' to the workflow", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-lint-apply-"));
    const target = join(base, "v");
    try {
      const initRes = await domeInit(target);
      expect(initRes.ok).toBe(true);

      const mock = makeNoopMockModel();
      const res = await domeLint(target, { model: mock, skipCommit: true }, ["H1"]);
      expect(res.ok).toBe(true);

      expect(mock.doGenerateCalls.length).toBeGreaterThanOrEqual(1);
      const user = readUserMessage(mock.doGenerateCalls[0]!);
      expect(user).toContain("apply H1");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
