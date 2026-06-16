// src/agent/loop.ts
//
// Provider-neutral read-only tool-calling loop for the ask-agent backend.
// Adapted from assets/extensions/dome.agent/lib/agent-loop.ts — no imports
// from assets/; this is a standalone reproduction of the minimal loop.

import type { ModelMessage } from "../core/processor";
import type { AskTool, AskState } from "./types";

export type AskLoopResult = {
  readonly finalText: string | null;
  readonly stopReason: "final" | "budget";
  readonly steps: number;
};

export type AskStepFn = (req: {
  readonly messages: ReadonlyArray<ModelMessage>;
  readonly tools: ReadonlyArray<AskTool["schema"]>;
}) => Promise<{ readonly toolCalls?: ReadonlyArray<{ id: string; name: string; input: unknown }>; readonly text?: string }>;

export async function runAskLoop(opts: {
  readonly charter: string;
  readonly question: string;
  readonly tools: ReadonlyArray<AskTool>;
  readonly step: AskStepFn;
  readonly maxSteps: number;
  readonly state: AskState;
}): Promise<AskLoopResult> {
  const messages: ModelMessage[] = [
    { role: "system", content: opts.charter },
    { role: "user", content: opts.question },
  ];
  const schemas = opts.tools.map((t) => t.schema);
  const byName = new Map(opts.tools.map((t) => [t.schema.name, t] as const));

  let steps = 0;
  while (steps < opts.maxSteps) {
    steps += 1;
    const resp = await opts.step({ messages, tools: schemas });
    const calls = resp.toolCalls ?? [];
    if (calls.length === 0) {
      return { finalText: resp.text ?? null, stopReason: "final", steps };
    }
    messages.push({ role: "assistant", content: resp.text ?? "", toolCalls: calls });
    for (const call of calls) {
      const tool = byName.get(call.name);
      const content =
        tool === undefined
          ? `error: unknown tool "${call.name}"`
          : await tool.execute(call.input, opts.state);
      messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, content });
    }
  }
  return { finalText: null, stopReason: "budget", steps };
}
