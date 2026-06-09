import { describe, expect, test } from "bun:test";
import {
  runAgentLoop,
  type AgentRunState,
  type AgentTool,
  type ModelStepFn,
} from "../../../assets/extensions/dome.agent/lib/agent-loop";

function scriptedStep(
  responses: ReadonlyArray<Awaited<ReturnType<ModelStepFn>>>,
): ModelStepFn {
  let i = 0;
  return async () => {
    const r = responses[i] ?? { text: "done" };
    i += 1;
    return r;
  };
}

const writePage: AgentTool = {
  schema: { name: "writePage", description: "write", inputSchema: {} },
  execute: async (input, state) => {
    const { path, content } = input as { path: string; content: string };
    state.edits.set(path, { kind: "write", path, content });
    return `wrote ${path}`;
  },
};

const askOwner: AgentTool = {
  schema: { name: "askOwner", description: "ask", inputSchema: {} },
  execute: async (input, state) => {
    const { question } = input as { question: string };
    state.questions.push({ question, idempotencyKey: `q:${question}` });
    return "asked";
  },
};

describe("runAgentLoop", () => {
  test("executes tool calls in order then stops on final text", async () => {
    const step = scriptedStep([
      {
        toolCalls: [
          { id: "1", name: "writePage", input: { path: "wiki/a.md", content: "A" } },
          { id: "2", name: "askOwner", input: { question: "ok?" } },
        ],
      },
      { text: "all done" },
    ]);
    const result = await runAgentLoop({
      charter: "c",
      task: "t",
      tools: [writePage, askOwner],
      step,
      maxSteps: 10,
    });
    expect(result.stopReason).toBe("final");
    expect(result.finalText).toBe("all done");
    expect(result.state.edits.get("wiki/a.md")).toEqual({
      kind: "write",
      path: "wiki/a.md",
      content: "A",
    });
    expect(result.state.questions[0]?.question).toBe("ok?");
  });

  test("stops at maxSteps and keeps accumulated edits", async () => {
    const step = scriptedStep([
      { toolCalls: [{ id: "1", name: "writePage", input: { path: "x.md", content: "X" } }] },
      { toolCalls: [{ id: "2", name: "writePage", input: { path: "y.md", content: "Y" } }] },
      { toolCalls: [{ id: "3", name: "writePage", input: { path: "z.md", content: "Z" } }] },
    ]);
    const result = await runAgentLoop({
      charter: "c", task: "t", tools: [writePage], step, maxSteps: 2,
    });
    expect(result.stopReason).toBe("budget");
    expect(result.steps).toBe(2);
    expect(result.state.edits.size).toBe(2);
  });

  test("unknown tool returns an error result without throwing", async () => {
    const step = scriptedStep([
      { toolCalls: [{ id: "1", name: "nope", input: {} }] },
      { text: "fine" },
    ]);
    const result = await runAgentLoop({
      charter: "c", task: "t", tools: [writePage], step, maxSteps: 5,
    });
    expect(result.stopReason).toBe("final");
  });

  test("an injected shared state accumulates edits across successive runs", async () => {
    const shared: AgentRunState = { edits: new Map(), questions: [] };
    const writeOnce = (path: string, content: string): ModelStepFn => {
      let n = 0;
      return async () => {
        n += 1;
        return n === 1
          ? { toolCalls: [{ id: "1", name: "writePage", input: { path, content } }] }
          : { text: "done" };
      };
    };
    await runAgentLoop({
      charter: "c", task: "t", tools: [writePage], step: writeOnce("x.md", "X"), maxSteps: 5, state: shared,
    });
    await runAgentLoop({
      charter: "c", task: "t", tools: [writePage], step: writeOnce("y.md", "Y"), maxSteps: 5, state: shared,
    });
    expect(shared.edits.get("x.md")).toBeDefined();
    expect(shared.edits.get("y.md")).toBeDefined(); // both runs accumulated into the shared state
  });

  test("trims old tool exchanges to stay under the context budget", async () => {
    const seenSizes: number[] = [];
    const big = "x".repeat(10_000);
    const bigTool: AgentTool = {
      schema: { name: "read", description: "", inputSchema: {} },
      execute: async () => big,
    };
    const step: ModelStepFn = async ({ messages }) => {
      const size = messages.reduce(
        (n, m) =>
          n +
          (typeof (m as { content?: unknown }).content === "string"
            ? (m as { content: string }).content.length
            : 0),
        0,
      );
      seenSizes.push(size);
      expect(messages[0]?.role).toBe("system"); // system survives trimming
      return {
        toolCalls: [{ id: String(seenSizes.length), name: "read", input: {} }],
      };
    };
    const result = await runAgentLoop({
      charter: "system charter",
      task: "the task",
      tools: [bigTool],
      step,
      maxSteps: 30,
      maxContextChars: 25_000,
    });
    expect(result.stopReason).toBe("budget");
    // Unbounded, 30 steps × 10k ≈ 300k chars. Trimming keeps each step bounded.
    expect(Math.max(...seenSizes)).toBeLessThan(60_000);
  });
});
