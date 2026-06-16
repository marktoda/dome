// src/agent/types.ts
//
// Types for the ask-agent backend (companion entrypoint). Kept LLM-SDK-free:
// the model loop talks to the vault's configured command model provider via
// the ModelStepProvider seam, which is pure subprocess + fetch.

import type { ModelStepProvider } from "../engine/core/model-invoke";
import type { ModelToolSchema } from "../core/processor";

/** A source the answer rests on — surfaced by a read tool during the run. */
export type AskCitation = {
  readonly path: string;
  readonly commit?: string | undefined;
  readonly snippet?: string | undefined;
};

/** Mutable run state threaded through tool executions. */
export type AskState = {
  readonly citations: AskCitation[];
};

/** A read-only tool the ask agent can call. */
export type AskTool = {
  readonly schema: ModelToolSchema;
  readonly execute: (input: unknown, state: AskState) => Promise<string>;
};

/** The synthesized answer plus the evidence it cited. */
export type AskResult = {
  readonly answer: string;
  readonly citations: ReadonlyArray<AskCitation>;
  readonly steps: number;
  readonly stopReason: "final" | "budget";
};

export type { ModelStepProvider };
