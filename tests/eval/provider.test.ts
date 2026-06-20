import { describe, expect, test } from "bun:test";
import type { ModelStepRequest, ModelStepResponse } from "../../src/engine/core/model-invoke";
import { scriptedRecordingStep, hermeticEvalEnv, liveEvalEnv } from "../../src/eval/provider";

/** Minimal valid ModelStepRequest (messages + tools + signal) */
function makeRequest(): ModelStepRequest {
  return {
    messages: [{ role: "user", content: "go" }],
    tools: [],
    signal: new AbortController().signal,
  };
}

/** A response with one tool call */
const TOOL_CALL_RESPONSE: ModelStepResponse = {
  toolCalls: [{ id: "1", name: "search_vault", input: {} }],
};

/** A response with only text */
const TEXT_RESPONSE: ModelStepResponse = {
  text: "final",
};

describe("scriptedRecordingStep", () => {
  test("returns scripted responses in order, terminal after exhaustion, records trajectory", async () => {
    const { provider, trajectory } = scriptedRecordingStep([
      TOOL_CALL_RESPONSE,
      TEXT_RESPONSE,
    ]);

    const req = makeRequest();

    // Call 1: scripted tool-call response
    const r1 = await provider(req);
    expect(r1).toEqual(TOOL_CALL_RESPONSE);

    // Call 2: scripted text response
    const r2 = await provider(req);
    expect(r2).toEqual(TEXT_RESPONSE);

    // Call 3: past end → terminal default
    const r3 = await provider(req);
    expect(r3).toMatchObject({ text: expect.any(String) });
    // terminal must have no tool calls (or empty)
    expect((r3.toolCalls ?? []).length).toBe(0);

    // Only 2 entries recorded (not 3 — terminal is not recorded after script end)
    expect(trajectory).toHaveLength(2);

    expect(trajectory[0]).toEqual({
      step: 0,
      toolCalls: [{ name: "search_vault" }],
      text: null,
    });
    expect(trajectory[1]).toEqual({
      step: 1,
      toolCalls: [],
      text: "final",
    });
  });
});

describe("hermeticEvalEnv", () => {
  test("returns env with mode hermetic and a working provider", async () => {
    const { env, trajectory } = hermeticEvalEnv([TOOL_CALL_RESPONSE]);
    expect(env.mode).toBe("hermetic");
    const r = await env.modelStepProvider(makeRequest());
    expect(r).toEqual(TOOL_CALL_RESPONSE);
    expect(trajectory).toHaveLength(1);
  });
});

describe("liveEvalEnv", () => {
  test("throws loudly when ANTHROPIC_API_KEY is absent", () => {
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      expect(() => liveEvalEnv()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
    }
  });
});
