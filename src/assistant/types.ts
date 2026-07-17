// src/assistant/types.ts
//
// Types for the agent backend (companion entrypoint).
//
// This backend is a COMPANION HTTP service reached only via dynamic import from
// the CLI — it is NOT part of the @marktoda/dome core static graph, so it is allowed
// to depend on the Vercel AI SDK. These are provider-neutral citation, change,
// and conversation carriers used across the runtime boundary.

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

/**
 * Provider-neutral conversation history owned by AgentRuntime. Tool calls and
 * provider metadata deliberately do not cross this seam; adapters receive the
 * prior user/assistant prose needed for a coherent next turn.
 */
export type AgentMessage = {
  readonly role: "user" | "assistant";
  readonly content: string;
};
