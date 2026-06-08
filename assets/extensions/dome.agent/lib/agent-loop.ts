// dome.agent — the autonomous-agent loop harness.
//
// Drives a true tool-use loop using an injected model-step function (in
// production, ctx.modelInvoke.step). The loop is provider-neutral: every step
// rides the model.invoke seam. Tools execute in-process and accumulate edits +
// questions into AgentRunState; the calling processor translates that state
// into a single PatchEffect + QuestionEffects. Injecting `step` is the test
// seam — no network in unit tests.

import type {
  ModelMessage,
  ModelStepInput,
  ModelStepResult,
  ModelToolSchema,
} from "../../../../src/core/processor";

export type AgentEdit =
  | { readonly kind: "write"; readonly path: string; readonly content: string }
  | { readonly kind: "delete"; readonly path: string };

export type AgentQuestion = {
  readonly question: string;
  readonly idempotencyKey: string;
};

/** Mutable accumulator threaded to every tool's execute. Last write per path wins. */
export type AgentRunState = {
  readonly edits: Map<string, AgentEdit>;
  readonly questions: AgentQuestion[];
};

export type AgentTool = {
  readonly schema: ModelToolSchema;
  readonly execute: (input: unknown, state: AgentRunState) => Promise<string>;
};

export type ModelStepFn = (input: ModelStepInput) => Promise<ModelStepResult>;

export type AgentRunResult = {
  readonly state: AgentRunState;
  readonly stopReason: "final" | "budget";
  readonly steps: number;
  readonly finalText: string | null;
};

export async function runAgentLoop(opts: {
  readonly charter: string;
  readonly task: string;
  readonly tools: ReadonlyArray<AgentTool>;
  readonly step: ModelStepFn;
  readonly maxSteps: number;
}): Promise<AgentRunResult> {
  const messages: ModelMessage[] = [
    { role: "system", content: opts.charter },
    { role: "user", content: opts.task },
  ];
  const state: AgentRunState = { edits: new Map(), questions: [] };
  const schemas = opts.tools.map((t) => t.schema);
  const toolByName = new Map(opts.tools.map((t) => [t.schema.name, t] as const));

  let steps = 0;
  while (steps < opts.maxSteps) {
    steps += 1;
    const resp = await opts.step({ messages, tools: schemas });
    const calls = resp.toolCalls ?? [];
    if (calls.length === 0) {
      return {
        state,
        stopReason: "final",
        steps,
        finalText: resp.text ?? null,
      };
    }
    messages.push({
      role: "assistant",
      content: resp.text ?? "",
      toolCalls: calls,
    });
    for (const call of calls) {
      const tool = toolByName.get(call.name);
      const content =
        tool === undefined
          ? `error: unknown tool "${call.name}"`
          : await runTool(tool, call.input, state);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        content,
      });
    }
  }
  return { state, stopReason: "budget", steps, finalText: null };
}

async function runTool(
  tool: AgentTool,
  input: unknown,
  state: AgentRunState,
): Promise<string> {
  try {
    return await tool.execute(input, state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `error: ${message}`;
  }
}
