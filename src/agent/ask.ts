// src/agent/ask.ts
//
// Orchestration entry-point for the ask-agent backend.
//
// Runs a multi-step, tool-calling agent loop via the Vercel AI SDK's
// generateText(): the model searches/reads the vault through the tools built by
// buildAskTools, grounding its answer in the owner's vault. Citations gathered
// by the tools during generation are read back into the AskResult.

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
import { buildAskTools } from "./tools";
import type { AskCitation, AskResult } from "./types";

/** Default interactive-ask model. Overridable via opts.modelId. */
export const DEFAULT_MODEL = "claude-sonnet-4-5";

const ASK_CHARTER = [
  "You are the owner's second-brain assistant. Answer the owner's question using ONLY their vault.",
  "Always call search_vault first to find relevant pages, then read_document for detail before answering.",
  "Ground every claim in the vault. If the vault does not contain the answer, say so plainly — never invent.",
  "Cite the pages you used inline as [path]. Be concise and direct; lead with the answer.",
].join(" ");

/** Shared option shape for both the buffered and streaming entry-points. */
type AskOptions = {
  readonly vault: Vault;
  readonly question: string;
  readonly modelId?: string | undefined;
  /** Injectable model for tests; defaults to anthropic(modelId ?? DEFAULT_MODEL). */
  readonly model?: LanguageModel | undefined;
  readonly maxSteps?: number | undefined;
  readonly abortSignal?: AbortSignal | undefined;
};

/**
 * Resolve the shared agent-loop setup — charter, citation carrier, tool set,
 * model, step budget — used identically by runAsk and runAskStream. Keeping
 * this in one place means the charter and tool wiring are never duplicated.
 */
function setupAsk(opts: AskOptions): {
  readonly model: LanguageModel;
  readonly system: string;
  readonly prompt: string;
  readonly tools: ToolSet;
  readonly maxSteps: number;
  readonly citations: AskCitation[];
  readonly abortSignal: AbortSignal | undefined;
} {
  const citations: AskCitation[] = [];
  return {
    model: opts.model ?? anthropic(opts.modelId ?? DEFAULT_MODEL),
    system: ASK_CHARTER,
    prompt: opts.question,
    tools: buildAskTools(opts.vault, citations),
    maxSteps: opts.maxSteps ?? 8,
    citations,
    abortSignal: opts.abortSignal,
  };
}

/**
 * Map the AI SDK's unified finishReason onto our coarse stopReason. "stop"
 * means the model ended naturally; anything else (e.g. "tool-calls" when the
 * step cap fired mid-loop, or "length") means we were cut off.
 */
function stopReasonOf(finishReason: FinishReason): AskResult["stopReason"] {
  return finishReason === "stop" ? "final" : "budget";
}

export async function runAsk(opts: AskOptions): Promise<AskResult> {
  const { model, system, prompt, tools, maxSteps, citations, abortSignal } =
    setupAsk(opts);

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

  return { answer, citations, steps: steps.length, stopReason };
}

/**
 * The streaming counterpart of an ask run. The server iterates `fullStream` to
 * forward text deltas to the client as they arrive; `citations` is the SAME
 * array the tools push into during the run (complete once the stream drains);
 * `finished` resolves after the stream fully drains with the coarse stopReason.
 */
export type AskStream = {
  /** The AI SDK fullStream: text-delta / tool-call / tool-result / finish / error parts. */
  readonly fullStream: AsyncIterable<TextStreamPart<ToolSet>>;
  /** Populated as the tools run; complete once `finished` resolves. */
  readonly citations: AskCitation[];
  /** Resolves after the stream drains with the run's coarse stopReason. */
  readonly finished: Promise<{ readonly stopReason: AskResult["stopReason"] }>;
};

/**
 * Streaming sibling of runAsk: drives the same agent loop via streamText so a
 * voice/chat client gets token-by-token output. Shares all setup (charter,
 * tools, model, budget) with runAsk via setupAsk. The returned value is both
 * iterable (fullStream) and readable-after (citations once finished resolves).
 */
export function runAskStream(opts: AskOptions): AskStream {
  const { model, system, prompt, tools, maxSteps, citations, abortSignal } =
    setupAsk(opts);

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
