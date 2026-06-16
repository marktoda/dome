import { describe, expect, test } from "bun:test";
import { runAsk } from "../../src/agent/ask";

function fakeVault() {
  return {
    runView: async () => ({
      kind: "ok",
      structured: { data: { matches: [{ title: "RH", path: "wiki/entities/robinhood-chain.md", snippet: "July 2026", sourceRefs: [{ path: "wiki/entities/robinhood-chain.md", commit: "c1" }] }] } },
    }),
    readDocument: async (p: string) => ({ path: p, commit: "c1", content: "Robinhood Chain launches July 2026." }),
  } as never;
}

describe("runAsk", () => {
  test("returns a synthesized answer with citations gathered from tools", async () => {
    const steps = [
      { toolCalls: [{ id: "1", name: "search_vault", input: { text: "robinhood launch" } }] },
      { toolCalls: [{ id: "2", name: "read_document", input: { path: "wiki/entities/robinhood-chain.md" } }] },
      { text: "Robinhood Chain launches in early July 2026." },
    ];
    let i = 0;
    const result = await runAsk({
      vault: fakeVault(),
      step: async () => steps[i++]!,
      question: "When does Robinhood Chain launch?",
      maxSteps: 6,
    });
    expect(result.answer).toContain("July 2026");
    expect(result.citations.map((c) => c.path)).toContain("wiki/entities/robinhood-chain.md");
    expect(result.stopReason).toBe("final");
  });

  test("budget exhaustion yields a graceful answer, not null", async () => {
    const result = await runAsk({
      vault: fakeVault(),
      step: async () => ({ toolCalls: [{ id: "1", name: "search_vault", input: { text: "x" } }] }),
      question: "q",
      maxSteps: 2,
    });
    expect(typeof result.answer).toBe("string");
    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.stopReason).toBe("budget");
  });
});
