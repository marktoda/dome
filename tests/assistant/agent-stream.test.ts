import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { runAgentStream } from "../../src/assistant/agent";

function fakeVault() {
  return {
    runView: async () => ({
      kind: "ok",
      structured: {
        data: {
          matches: [
            {
              title: "RH",
              path: "wiki/entities/robinhood-chain.md",
              snippet: "July 2026",
              sourceRefs: [
                { path: "wiki/entities/robinhood-chain.md", commit: "c1" },
              ],
            },
          ],
        },
      },
    }),
    readDocument: async (p: string) => ({
      path: p,
      commit: "c1",
      content: "Robinhood Chain launches July 2026.",
    }),
  } as never;
}

// Low-level LanguageModelV3StreamPart shapes (provider v3) fed to the mock's
// doStream via simulateReadableStream: text-start / text-delta(.delta) /
// text-end / finish(.finishReason {unified, raw}). Confirmed against installed
// @ai-sdk/provider v3 + ai@6 ai/test.
const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function textStreamModel(deltas: string[], unified: "stop" | "tool-calls" = "stop") {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "t1" },
          ...deltas.map((delta) => ({ type: "text-delta" as const, id: "t1", delta })),
          { type: "text-end", id: "t1" },
          {
            type: "finish" as const,
            finishReason: { unified, raw: unified === "stop" ? "end_turn" : "tool_use" },
            usage,
          },
        ],
      }),
    }),
  });
}

describe("runAgentStream", () => {
  test("streams text deltas through fullStream and resolves finished=final", async () => {
    const ask = runAgentStream({
      vault: fakeVault(),
      model: textStreamModel(["Robinhood ", "Chain ", "launches July 2026."]),
      question: "When does Robinhood Chain launch?",
      maxSteps: 6,
    });

    const deltas: string[] = [];
    for await (const part of ask.fullStream) {
      if (part.type === "text-delta") deltas.push(part.text);
    }
    expect(deltas.join("")).toBe("Robinhood Chain launches July 2026.");

    const { stopReason } = await ask.finished;
    expect(stopReason).toBe("final");
  });

  test("resolves finished=budget when the model never reaches a natural stop", async () => {
    const ask = runAgentStream({
      vault: fakeVault(),
      model: textStreamModel(["partial"], "tool-calls"),
      question: "Does this answer exist?",
      maxSteps: 2,
    });

    // Drain the stream.
    for await (const _part of ask.fullStream) {
      // no-op
    }
    const { stopReason } = await ask.finished;
    expect(stopReason).toBe("budget");
  });
});
