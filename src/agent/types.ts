// src/agent/types.ts
//
// Types for the ask-agent backend (companion entrypoint).
//
// This backend is a COMPANION HTTP service reached only via dynamic import from
// the CLI — it is NOT part of the @dome/sdk core static graph, so it is allowed
// to depend on the Vercel AI SDK. The agent loop + tool-calling are provided by
// `ai`'s generateText(); these types are just the citation carrier + result.

/** A source the answer rests on — surfaced by a read tool during the run. */
export type Citation = {
  readonly path: string;
  readonly commit?: string | undefined;
  readonly snippet?: string | undefined;
};

/** The synthesized answer plus the evidence it cited. */
export type AgentResult = {
  readonly answer: string;
  readonly citations: ReadonlyArray<Citation>;
  readonly steps: number;
  readonly stopReason: "final" | "budget";
};
