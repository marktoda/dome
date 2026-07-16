import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { runAgentStream } from "../../src/assistant/agent";
import type { ModelStepProvider } from "../../src/engine/core/model-invoke";

function fakeVault() {
  return {
    listViews: () => [
      { command: "query", processorId: "dome.search.query", processorVersion: "1", extensionId: "dome.search" },
    ],
    runView: async () => ({
      kind: "ok",
      views: [],
      brokerDiagnostics: [],
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

  test("runs tools and records citations through an injected step provider", async () => {
    let calls = 0;
    const provider: ModelStepProvider = async (request) => {
      calls += 1;
      expect(request.tools.map((tool) => tool.name)).toContain("read_document");
      if (calls === 1) {
        expect(request.messages.at(-1)).toMatchObject({
          role: "user",
          content: "When does Robinhood Chain launch?",
        });
        return {
          toolCalls: [{
            id: "read-1",
            name: "read_document",
            input: { path: "wiki/entities/robinhood-chain.md" },
          }],
        };
      }
      expect(request.messages).toContainEqual(expect.objectContaining({
        role: "tool",
        toolCallId: "read-1",
        toolName: "read_document",
        content: "Robinhood Chain launches July 2026.",
      }));
      return { text: "Robinhood Chain launches July 2026." };
    };

    const ask = runAgentStream({
      vault: fakeVault(),
      modelStepProvider: provider,
      question: "When does Robinhood Chain launch?",
    });
    const deltas: string[] = [];
    for await (const part of ask.fullStream) {
      if (part.type === "text-delta") deltas.push(part.text);
    }

    expect(deltas.join("")).toBe("Robinhood Chain launches July 2026.");
    expect(ask.citations).toEqual([{
      path: "wiki/entities/robinhood-chain.md",
      commit: "c1",
    }]);
    expect((await ask.finished).stopReason).toBe("final");
    expect(calls).toBe(2);
  });
});
