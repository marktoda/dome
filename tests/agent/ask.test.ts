import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { runAsk } from "../../src/agent/ask";

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

// Confirmed LanguageModelV3GenerateResult shape (ai@6, @ai-sdk/provider v3):
//   { content: LanguageModelV3Content[], finishReason: {unified, raw}, usage, warnings }
//   - tool-call content: {type:"tool-call", toolCallId, toolName, input: <stringified JSON>}
//   - final text content: {type:"text", text}
//   - finishReason.unified "tool-calls" triggers another step; "stop" ends.
//   - usage uses nested inputTokens/outputTokens objects.
const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function toolCallStep(toolName: string, input: unknown) {
  return {
    content: [
      {
        type: "tool-call" as const,
        toolCallId: `${toolName}-1`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
    usage,
    warnings: [],
  };
}

function textStep(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "end_turn" },
    usage,
    warnings: [],
  };
}

describe("runAsk", () => {
  test("drives the AI SDK loop through tools and returns answer + citations", async () => {
    // Step 1: model calls search_vault. Step 2: model calls read_document.
    // Step 3: model emits final text. (The SDK collapses the trailing tool-call
    // + final text into the same step group, so steps.length lands at 2 — what
    // matters here is the grounded answer + the citations the tools recorded.)
    const model = new MockLanguageModelV3({
      doGenerate: [
        toolCallStep("search_vault", { text: "robinhood launch" }),
        toolCallStep("read_document", {
          path: "wiki/entities/robinhood-chain.md",
        }),
        textStep("Robinhood Chain launches in early July 2026."),
      ],
    });

    const result = await runAsk({
      vault: fakeVault(),
      model,
      question: "When does Robinhood Chain launch?",
      maxSteps: 6,
    });

    expect(result.answer).toContain("July 2026");
    expect(result.citations.map((c) => c.path)).toContain(
      "wiki/entities/robinhood-chain.md",
    );
    expect(result.stopReason).toBe("final");
    expect(result.steps).toBeGreaterThanOrEqual(2);
  });
});
