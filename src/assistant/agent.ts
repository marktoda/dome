// src/assistant/agent.ts
//
// Orchestration entry-point for the agent backend.
//
// Runs a multi-step, tool-calling agent loop via the Vercel AI SDK's
// generateText(): the model searches/reads the vault through the tools built by
// buildAgentTools, grounding its answer in the owner's vault. Citations gathered
// by the tools during generation are read back into the AgentResult.

import {
  generateText,
  streamText,
  stepCountIs,
  type FinishReason,
  type LanguageModel,
  type ToolSet,
  type TextStreamPart,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { Vault } from "../vault";
import { buildAgentTools, type AgentWriteContext } from "./tools";
import type { Citation, AgentResult, AgentChange } from "./types";

/** Default interactive-ask model. Overridable via opts.modelId. */
export const DEFAULT_MODEL = "claude-sonnet-4-5";

const AGENT_CHARTER = [
  "You are the owner's second-brain assistant. Answer using ONLY their vault.",
  "Silently call search_vault first, then read_document for detail. Do NOT narrate your tool use — never write 'let me read…', 'I'll search…', or describe your steps. Output only the answer itself.",
  "Ground every claim in the vault. If the vault does not contain the answer, say so plainly — never invent.",
  "Be brief: lead with the direct answer in 1–3 sentences, then only essential detail. Prefer plain prose; use a short markdown list only when it genuinely helps.",
  "Format as clean markdown — blank lines between paragraphs and before any list. Never emit a heading marker (#) mid-sentence. The app displays your sources separately, so do not clutter the prose with file paths or [bracketed] citations.",
].join(" ");

const WRITE_CHARTER = [
  "You can also modify the vault. Use create_document for a new page and edit_document for a surgical, unique-substring edit to an existing page (e.g. checking off a task: '- [ ]' → '- [x]').",
  "Make the smallest change that satisfies the request, then briefly state what you changed. Never write under .dome/.",
].join(" ");

/** Shared option shape for both the buffered and streaming entry-points. */
type AgentOptions = {
  readonly vault: Vault;
  readonly question: string;
  readonly modelId?: string | undefined;
  /** Injectable model for tests; defaults to anthropic(modelId ?? DEFAULT_MODEL). */
  readonly model?: LanguageModel | undefined;
  readonly maxSteps?: number | undefined;
  readonly abortSignal?: AbortSignal | undefined;
  /** Grant the author capability: provisions create_document / edit_document. */
  readonly allowWrite?: boolean | undefined;
};

/**
 * Resolve the shared agent-loop setup — charter, citation carrier, tool set,
 * model, step budget — used identically by runAgent and runAgentStream. Keeping
 * this in one place means the charter and tool wiring are never duplicated.
 */
function setupAgent(opts: AgentOptions): {
  readonly model: LanguageModel;
  readonly system: string;
  readonly prompt: string;
  readonly tools: ToolSet;
  readonly maxSteps: number;
  readonly citations: Citation[];
  readonly changes: AgentChange[];
  readonly abortSignal: AbortSignal | undefined;
} {
  const citations: Citation[] = [];
  const changes: AgentChange[] = [];
  const modelId = opts.modelId ?? DEFAULT_MODEL;
  const write: AgentWriteContext | undefined =
    opts.allowWrite === true
      ? { vaultPath: opts.vault.path, modelId, changes }
      : undefined;
  return {
    model: opts.model ?? anthropic(modelId),
    system: write !== undefined ? `${AGENT_CHARTER} ${WRITE_CHARTER}` : AGENT_CHARTER,
    prompt: opts.question,
    tools: buildAgentTools(opts.vault, citations, write),
    maxSteps: opts.maxSteps ?? 8,
    citations,
    changes,
    abortSignal: opts.abortSignal,
  };
}

/**
 * Map the AI SDK's unified finishReason onto our coarse stopReason. "stop"
 * means the model ended naturally; anything else (e.g. "tool-calls" when the
 * step cap fired mid-loop, or "length") means we were cut off.
 */
function stopReasonOf(finishReason: FinishReason): AgentResult["stopReason"] {
  return finishReason === "stop" ? "final" : "budget";
}

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const { model, system, prompt, tools, maxSteps, citations, changes, abortSignal } =
    setupAgent(opts);

  const { text, steps, finishReason } = await generateText({
    model,
    system,
    prompt,
    tools,
    stopWhen: stepCountIs(maxSteps),
    ...(abortSignal !== undefined ? { abortSignal } : {}),
  });

  const stopReason = stopReasonOf(finishReason);

  const answer =
    text.trim().length > 0
      ? text
      : "I couldn't reach a complete answer within the step budget. Here's what I found: " +
        (citations.length > 0
          ? citations.map((c) => c.path).join(", ")
          : "no relevant vault pages.");

  return { answer, citations, steps: steps.length, stopReason, changes };
}

/**
 * The streaming counterpart of an ask run. The server iterates `fullStream` to
 * forward text deltas to the client as they arrive; `citations` is the SAME
 * array the tools push into during the run (complete once the stream drains);
 * `finished` resolves after the stream fully drains with the coarse stopReason.
 */
export type AgentStream = {
  /** The AI SDK fullStream: text-delta / tool-call / tool-result / finish / error parts. */
  readonly fullStream: AsyncIterable<TextStreamPart<ToolSet>>;
  /** Populated as the tools run; complete once `finished` resolves. */
  readonly citations: Citation[];
  /** Vault writes made this run; same array the tools push into — complete once `finished` resolves. */
  readonly changes: AgentChange[];
  /** Resolves after the stream drains with the run's coarse stopReason. */
  readonly finished: Promise<{ readonly stopReason: AgentResult["stopReason"] }>;
};

/**
 * Streaming sibling of runAgent: drives the same agent loop via streamText so a
 * voice/chat client gets token-by-token output. Shares all setup (charter,
 * tools, model, budget) with runAgent via setupAgent. The returned value is both
 * iterable (fullStream) and readable-after (citations once finished resolves).
 */
export function runAgentStream(opts: AgentOptions): AgentStream {
  const { model, system, prompt, tools, maxSteps, citations, changes, abortSignal } =
    setupAgent(opts);

  const result = streamText({
    model,
    system,
    prompt,
    tools,
    stopWhen: stepCountIs(maxSteps),
    ...(abortSignal !== undefined ? { abortSignal } : {}),
  });

  return {
    fullStream: result.fullStream,
    citations,
    changes,
    // Never rejects: on abort-before-first-step the AI SDK may reject
    // result.finishReason, which would leave a dangling unhandledRejection if
    // the route's for-await throws before reaching `await stream.finished`.
    // Catch here and fall back to "budget" so the promise is always settled.
    finished: Promise.resolve(result.finishReason).then(
      (finishReason) => ({ stopReason: stopReasonOf(finishReason) }),
      () => ({ stopReason: "budget" as const }),
    ),
  };
}
