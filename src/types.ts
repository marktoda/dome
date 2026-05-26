// Canonical types for the Dome SDK Tool surface.
// See docs/wiki/specs/sdk-surface.md §"Tool".

// ----- Result<T, E> ---------------------------------------------------------

export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

// ----- Effects --------------------------------------------------------------

export type UnifiedDiff = string; // patch text; v0.5 keeps it as a string

export type Effect =
  | { kind: "wrote-document"; path: string; diff: UnifiedDiff }
  | { kind: "appended-log"; entry: LogEntry }
  | { kind: "moved-document"; from: string; to: string }
  | { kind: "deleted-document"; path: string };

// ----- Log entries ----------------------------------------------------------

export type LogVerb = "ingest" | "query" | "lint" | "update" | "bootstrap" | string;

export type LogEntry = {
  ts: string; // ISO 8601
  verb: LogVerb;
  subject: string;
  body?: string;
  refs?: ReadonlyArray<string>;
};

// ----- ToolReturn -----------------------------------------------------------

export type ToolReturn<TOutput> = {
  result: Result<TOutput, ToolError>;
  effects: Effect[];
};

// ----- ToolError vocabulary -------------------------------------------------
// Canonical error kinds; each maps to a structural failure described in
// docs/wiki/invariants/<NAME>.md or a Tool-specific failure mode.

export type ToolError =
  | { kind: "invariant-violated"; invariant: InvariantName; detail: string }
  | { kind: "dispatcher-owned-path"; path: string; requested_tool: string }
  | { kind: "wikilink-not-fullpath"; link: string; suggestion?: string }
  | { kind: "frontmatter-mismatch"; field: string; expected: string; actual: string }
  | { kind: "page-creation-requires-reason"; path: string }
  | { kind: "sensitive-must-route-to-inbox"; path: string }
  | { kind: "concurrent-write-conflict"; path: string; expected_mtime: string; actual_mtime: string }
  | { kind: "not-found"; path: string }
  | { kind: "already-exists"; path: string }
  | { kind: "validation"; message: string }
  | { kind: "vault-not-git-repo"; path: string }
  | { kind: "config-invalid"; message: string };

// ----- Sensitivity & creation reason ----------------------------------------

export type Sensitivity = "normal" | "sensitive";
export type CreationReason = "recurring" | "named_explicitly" | "structural";

// ----- Invariant names ------------------------------------------------------
// Canonical list (axiom + shipped-default + opt-in). See docs/wiki/invariants/.

export const INVARIANTS = {
  RAW_IS_IMMUTABLE: "RAW_IS_IMMUTABLE",
  MARKDOWN_IS_SOURCE_OF_TRUTH: "MARKDOWN_IS_SOURCE_OF_TRUTH",
  LOG_IS_APPEND_ONLY: "LOG_IS_APPEND_ONLY",
  HOOKS_CANNOT_BYPASS_TOOLS: "HOOKS_CANNOT_BYPASS_TOOLS",
  VAULT_IS_GIT_REPO: "VAULT_IS_GIT_REPO",
  INDEX_AND_LOG_ARE_DISPATCHER_OWNED: "INDEX_AND_LOG_ARE_DISPATCHER_OWNED",
  EVERY_WRITE_IS_LOGGED: "EVERY_WRITE_IS_LOGGED",
  PAGE_TYPE_BY_DIRECTORY: "PAGE_TYPE_BY_DIRECTORY",
  WIKILINKS_ARE_FULLPATH: "WIKILINKS_ARE_FULLPATH",
  INBOX_IS_EPHEMERAL: "INBOX_IS_EPHEMERAL",
  SENSITIVE_GOES_TO_INBOX: "SENSITIVE_GOES_TO_INBOX",
  PAGE_CREATION_REQUIRES_RECURRENCE: "PAGE_CREATION_REQUIRES_RECURRENCE",
  CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY: "CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY",
} as const;

export type InvariantName = typeof INVARIANTS[keyof typeof INVARIANTS];

// ----- WikiLink -------------------------------------------------------------

export type WikiLink = {
  raw: string;     // "[[wiki/entities/danny]]" or "[[Danny]]"
  target: string;  // "wiki/entities/danny" or "Danny"
  isFullPath: boolean;
};

// ----- SearchMatch ----------------------------------------------------------

export type SearchMatch = {
  path: string;
  excerpt: string;
  score: number;
};
