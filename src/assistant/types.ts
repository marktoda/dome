// src/assistant/types.ts
//
// Types for the agent backend (companion entrypoint).
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

/**
 * A vault mutation the agent made during a run (surfaced to the client as
 * done.changes and recorded by the agent log). `create`/`edit` are the
 * author-gated page writes; the rest are the contract operations the
 * assistant shares with the HTTP routes and MCP tools. `path` names what
 * changed: a vault-relative file path for writes and captures,
 * `^<anchor>` for a settled task, `question:<id>` for a resolved
 * question, `proposal:<id>` for an applied/rejected proposal.
 */
export type AgentChange = {
  readonly path: string;
  readonly kind:
    | "create"
    | "edit"
    | "capture"
    | "settle"
    | "resolve"
    | "apply"
    | "reject";
};

/** The synthesized answer plus the evidence it cited and any writes it made. */
export type AgentResult = {
  readonly answer: string;
  readonly citations: ReadonlyArray<Citation>;
  readonly steps: number;
  readonly stopReason: "final" | "budget";
  /** Vault writes made this run; empty for read-only turns. */
  readonly changes: ReadonlyArray<AgentChange>;
};
