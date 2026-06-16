import { describe, expect, test } from "bun:test";
import { runAskLoop } from "../../src/agent/loop";
import type { AskTool, AskState } from "../../src/agent/types";

function tool(name: string, fn: (input: unknown, s: AskState) => Promise<string>): AskTool {
  return { schema: { name, description: name, inputSchema: { type: "object", properties: {}, additionalProperties: true } }, execute: fn };
}

describe("runAskLoop", () => {
  test("executes a tool call then returns the final text", async () => {
    const calls: string[] = [];
    const tools = [tool("search_vault", async () => { calls.push("search"); return "found X [wiki/x.md]"; })];
    const steps = [
      { toolCalls: [{ id: "1", name: "search_vault", input: { text: "x" } }] },
      { text: "X is the answer." },
    ];
    let i = 0;
    const step = async () => steps[i++]!;
    const state: AskState = { citations: [] };
    const result = await runAskLoop({ charter: "c", question: "what is X?", tools, step, maxSteps: 5, state });
    expect(calls).toEqual(["search"]);
    expect(result.stopReason).toBe("final");
    expect(result.finalText).toBe("X is the answer.");
  });

  test("stops at maxSteps with budget stopReason", async () => {
    const tools = [tool("loop", async () => "again")];
    const step = async () => ({ toolCalls: [{ id: "1", name: "loop", input: {} }] });
    const result = await runAskLoop({ charter: "c", question: "q", tools, step, maxSteps: 3, state: { citations: [] } });
    expect(result.stopReason).toBe("budget");
    expect(result.steps).toBe(3);
  });

  test("unknown tool yields an error observation, loop continues", async () => {
    const tools = [tool("known", async () => "ok")];
    const steps = [
      { toolCalls: [{ id: "1", name: "nope", input: {} }] },
      { text: "done" },
    ];
    let i = 0;
    const result = await runAskLoop({ charter: "c", question: "q", tools, step: async () => steps[i++]!, maxSteps: 5, state: { citations: [] } });
    expect(result.finalText).toBe("done");
  });
});
