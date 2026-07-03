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

/**
 * The four knowledge-integrity finding kinds a tool-loop agent can flag via
 * the `flagIntegrity` tool (folded in from the retired `dome.warden.integrity`
 * warden). Model judgment stays transient: each flag becomes a self-clearing
 * DiagnosticEffect, never a fact or a patch.
 */
export const INTEGRITY_FINDING_KINDS = [
  "historical-as-ongoing",
  "contradiction",
  "self-corroborating",
  "inference-as-fact",
] as const;

export type IntegrityFindingKind = (typeof INTEGRITY_FINDING_KINDS)[number];

/** One accumulated `flagIntegrity` finding, mapped later to a DiagnosticEffect. */
export type AgentIntegrityFlag = {
  readonly path: string;
  readonly kind: IntegrityFindingKind;
  readonly claim: string;
  /** Risk-mapped by the model: high-risk → "warning", else "info". */
  readonly severity: "info" | "warning";
  readonly fix: string;
};

/** Mutable accumulator threaded to every tool's execute. Last write per path wins. */
export type AgentRunState = {
  readonly edits: Map<string, AgentEdit>;
  readonly questions: AgentQuestion[];
  /** Knowledge-integrity findings flagged this run (consolidate's flagIntegrity tool). */
  readonly integrityFlags: AgentIntegrityFlag[];
};

export type AgentTool = {
  readonly schema: ModelToolSchema;
  readonly execute: (input: unknown, state: AgentRunState) => Promise<string>;
};

export type ModelStepFn = (input: ModelStepInput) => Promise<ModelStepResult>;

// Default context budget for the message history handed to each step, in
// characters (~4 chars/token → ~125K tokens), a safe margin under the common
// 200K-token provider input ceiling. Tool schemas + model output live outside
// this budget, so the margin absorbs them. The harness trims oldest tool-turns
// to stay under it — see `trimToFit`.
const DEFAULT_MAX_CONTEXT_CHARS = 500_000;

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
  readonly maxContextChars?: number;
  /**
   * Edit/question accumulator. Pass a shared instance to run several sources
   * through one run so each loop reads the prior loops' in-run edits (via the
   * overlay-aware tools) instead of clobbering them. Defaults to a fresh state.
   */
  readonly state?: AgentRunState;
}): Promise<AgentRunResult> {
  const maxContextChars = opts.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  const messages: ModelMessage[] = [
    { role: "system", content: opts.charter },
    { role: "user", content: opts.task },
  ];
  const state: AgentRunState =
    opts.state ?? { edits: new Map(), questions: [], integrityFlags: [] };
  const schemas = opts.tools.map((t) => t.schema);
  const toolByName = new Map(opts.tools.map((t) => [t.schema.name, t] as const));

  let steps = 0;
  while (steps < opts.maxSteps) {
    steps += 1;
    trimToFit(messages, maxContextChars);
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

function messageSize(m: ModelMessage): number {
  let n = m.content.length;
  if (m.role === "assistant" && m.toolCalls !== undefined) {
    for (const c of m.toolCalls) {
      n += c.name.length + JSON.stringify(c.input ?? null).length;
    }
  }
  return n;
}

// Keep the system message (index 0) + the initial user task (index 1); drop the
// oldest complete tool-turns — an assistant-with-toolCalls message and the tool
// results that follow it — until the history fits the budget. Dropping whole
// turns preserves tool_use/tool_result pairing. The EditAccumulator lives
// outside the message history, so trimming costs conversational memory, not
// work in progress (writes are idempotent by path).
function trimToFit(messages: ModelMessage[], maxChars: number): void {
  const total = (): number => messages.reduce((n, m) => n + messageSize(m), 0);
  while (total() > maxChars && messages.length > 2) {
    let end = 3; // drop at least the message at index 2 (the oldest assistant turn)
    while (end < messages.length && messages[end]?.role === "tool") end += 1;
    messages.splice(2, end - 2);
  }
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
