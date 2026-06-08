import { describe, expect, test } from "bun:test";
import {
  runAgentLoop,
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
});
