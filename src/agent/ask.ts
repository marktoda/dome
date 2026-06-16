// src/agent/ask.ts
//
// Orchestration entry-point for the ask-agent backend.
//
// Runs a multi-step, tool-calling agent loop via the Vercel AI SDK's
// generateText(): the model searches/reads the vault through the tools built by
// buildAskTools, grounding its answer in the owner's vault. Citations gathered
// by the tools during generation are read back into the AskResult.

import { generateText, stepCountIs, type LanguageModel } from "ai";
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

export async function runAsk(opts: {
  readonly vault: Vault;
  readonly question: string;
  readonly modelId?: string | undefined;
  /** Injectable model for tests; defaults to anthropic(modelId ?? DEFAULT_MODEL). */
  readonly model?: LanguageModel | undefined;
  readonly maxSteps?: number | undefined;
  readonly abortSignal?: AbortSignal | undefined;
}): Promise<AskResult> {
  const citations: AskCitation[] = [];
  const tools = buildAskTools(opts.vault, citations);
  const maxSteps = opts.maxSteps ?? 8;

  const { text, steps } = await generateText({
    model: opts.model ?? anthropic(opts.modelId ?? DEFAULT_MODEL),
    system: ASK_CHARTER,
    prompt: opts.question,
    tools,
    stopWhen: stepCountIs(maxSteps),
    ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
  });

  // The step cap was hit without the model producing a final answer ⇒ budget.
  const hitBudget = steps.length >= maxSteps && text.trim().length === 0;
  const stopReason: AskResult["stopReason"] = hitBudget ? "budget" : "final";

  const answer =
    text.trim().length > 0
      ? text
      : "I couldn't reach a complete answer within the step budget. Here's what I found: " +
        (citations.length > 0
          ? citations.map((c) => c.path).join(", ")
          : "no relevant vault pages.");

  return { answer, citations, steps: steps.length, stopReason };
}
