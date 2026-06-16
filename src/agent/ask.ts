// src/agent/ask.ts
//
// Orchestration entry-point for the ask-agent backend.
// Wires buildAskTools + runAskLoop into a single runAsk call that returns
// an AskResult with a synthesized answer and the citations gathered by tools.

import type { Vault } from "../vault";
import { buildAskTools } from "./tools";
import { runAskLoop, type AskStepFn } from "./loop";
import type { AskResult, AskState } from "./types";

const ASK_CHARTER = [
  "You are the owner's second-brain assistant. Answer the owner's question using ONLY their vault.",
  "Always call search_vault first to find relevant pages, then read_document for detail before answering.",
  "Ground every claim in the vault. If the vault does not contain the answer, say so plainly — never invent.",
  "Cite the pages you used inline as [path]. Be concise and direct; lead with the answer.",
].join(" ");

export async function runAsk(opts: {
  readonly vault: Vault;
  readonly step: AskStepFn;
  readonly question: string;
  readonly model?: string | undefined;
  readonly maxSteps?: number | undefined;
}): Promise<AskResult> {
  const tools = buildAskTools(opts.vault);
  const state: AskState = { citations: [] };
  const loop = await runAskLoop({
    charter: ASK_CHARTER,
    question: opts.question,
    tools,
    step: opts.step,
    maxSteps: opts.maxSteps ?? 8,
    state,
  });
  const answer =
    loop.finalText ??
    "I couldn't reach a complete answer within the step budget. Here's what I found: " +
      (state.citations.length > 0 ? state.citations.map((c) => c.path).join(", ") : "no relevant vault pages.");
  return { answer, citations: state.citations, steps: loop.steps, stopReason: loop.stopReason };
}
