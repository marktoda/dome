// assistant/agent-work: built-in AI SDK adapter for the AgentWorkAgent seam.
//
// This module is companion-only and may depend on model SDKs. The derived
// queue, evidence validation, and durable completion remain in model-free
// modules. Replacing this adapter changes no engine or protocol semantics.

import { anthropic } from "@ai-sdk/anthropic";
import {
  generateText,
  Output,
  stepCountIs,
  type LanguageModel,
} from "ai";
import { z } from "zod";

import type { AgentWorkAgent } from "../agent-work/attempt";
import { commitOid, sourceRef } from "../core/source-ref";
import type { Vault } from "../vault";
import { buildAgentTools } from "./tools";
import type { Citation } from "./types";
import { DEFAULT_MODEL } from "./agent";

const DecisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("answer"),
    answer: z.string().min(1),
    reason: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("defer"),
    reason: z.string().min(1),
  }).strict(),
]);

const CHARTER = [
  "You resolve one low-risk second-brain decision using only adopted vault evidence.",
  "Read every requiredEvidencePath with read_document before answering. You may use run_view to discover context, but it does not replace reading the required sources.",
  "Choose only a listed option when options are present. A recommendation is a hint, never evidence.",
  "Return defer when the sources do not support a choice. Never guess and never perform or claim an external action.",
].join(" ");

export type BuiltInAgentWorkOptions = {
  readonly vault: Vault;
  readonly modelId?: string;
  readonly model?: LanguageModel;
  readonly maxSteps?: number;
};

/** Create the production model adapter used by hosted/background drains. */
export function createBuiltInAgentWorkAgent(
  opts: BuiltInAgentWorkOptions,
): AgentWorkAgent {
  return async (item, signal) => {
    const citations: Citation[] = [];
    const result = await generateText({
      model: opts.model ?? anthropic(opts.modelId ?? DEFAULT_MODEL),
      system: CHARTER,
      prompt: JSON.stringify({
        task: "Investigate and decide this agent-work packet.",
        packet: item,
      }),
      tools: buildAgentTools(opts.vault, citations),
      stopWhen: stepCountIs(opts.maxSteps ?? 8),
      output: Output.object({ schema: DecisionSchema }),
      ...(signal !== undefined ? { abortSignal: signal } : {}),
    });
    if (result.output.kind === "defer") {
      return Object.freeze({
        kind: "defer" as const,
        reason: result.output.reason,
      });
    }
    return Object.freeze({
      kind: "answer" as const,
      answer: result.output.answer,
      reason: result.output.reason,
      evidence: Object.freeze(
        citations.flatMap((citation) =>
          citation.commit === undefined
            ? []
            : [sourceRef({
                path: citation.path,
                commit: commitOid(citation.commit),
              })]
        ),
      ),
    });
  };
}
