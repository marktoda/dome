// Public API surface — @dome/sdk core.
//
// Per CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY, this entrypoint does NOT
// re-export workflow-runner or MCP-server symbols. Those live at:
//
//   @dome/sdk/workflows — runWorkflow, WorkflowRegistry, PromptLoader,
//                         projectAiSdk, eval helpers, workflow types
//   @dome/sdk/mcp       — DomeMcpServer, McpSurface, renderMcp,
//                         ToolAdapter, McpPromptAdapter, ResourceAdapter
//   @dome/sdk/cli       — runCli, the seven dome* command functions
//
// The bundle-deps test at tests/integration/bundle-deps.test.ts pins
// the axiom; the public-surface-shape test catches symbol re-exports
// even when transitive deps stay clean.

export {
  openVault,
  appendCycleLogEntry,
  type Vault,
  type VaultConfig,
  type PageTypesConfig,
  type BoundToolSurface,
} from "./vault";
export { makeDocument, type Document, type DocumentCategory, type DocumentInput } from "./document";
export type { HookContext, HookHandler, HookEvent } from "./hook-context";
export type {
  Result,
  Effect,
  ToolReturn,
  ToolError,
  LogEntry,
  LogVerb,
  CreationReason,
  InvariantName,
  WikiLink,
  SearchMatch,
} from "./types";
export { INVARIANTS } from "./types";

export {
  buildAbstractSurface,
  type AbstractSurface,
  type PromptDescriptor,
  type ResourceDescriptor,
} from "./abstract-surface";

export { readDocument } from "./tools/read-document";
export { writeDocument } from "./tools/write-document";
export { appendLog } from "./tools/append-log";
export { searchIndex } from "./tools/search-index";
export { wikilinkResolve } from "./tools/wikilink-resolve";
export { moveDocument } from "./tools/move-document";
export { deleteDocument } from "./tools/delete-document";

// The privileged-writer type (writeIndex / appendLogEntry / removeIndexEntry)
// is INTENTIONALLY NOT exported. Plugin and vault-local code reach it only via
// `HookContext.privilegedWriter`, which the hook-dispatcher partitions to
// sdk-source hooks — the structural enforcement of
// INDEX_AND_LOG_ARE_DISPATCHER_OWNED.
export type { IndexEntry } from "./privileged-writer";

export { parseFrontmatter, stringifyFrontmatter } from "./frontmatter";
export { parseWikilinks, isFullPathLink, suggestFullPath } from "./wikilinks";

export { HookRegistry, type RegisteredHook, type HookSource } from "./hook-registry";
export { HookDispatcher, type CausationLink, type CycleInfo, type HookDispatcherOpts } from "./hook-dispatcher";
export { autoUpdateIndex } from "./hooks/auto-update-index";
export { autoCrossReference } from "./hooks/auto-cross-reference";
export { VaultWatcher, type OOBEvent } from "./watcher";
export { reconcile, type ReconcileOpts, type ReconcileResult } from "./reconcile";
export { commitWorkflow, type WorkflowCommitInput } from "./workflow-commit";
export { projectEffectToEvents, projectEffectsToEvents } from "./event-projection";

// Canonical Tool registry — single source of truth for the seven Tools.
// Plugin and harness authors that want to enumerate or extend the Tool
// surface consume these. AI-SDK-shaped projections (`filterAiTools`,
// `projectAiSdk`) live in @dome/sdk/workflows.
export {
  TOOL_NAMES,
  MCP_TOOL_NAMES,
  MUTATING_TOOL_NAMES,
  type ToolName,
} from "./tools/registry";
