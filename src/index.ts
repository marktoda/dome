// Public API surface — what plugin and harness authors consume.

export { openVault, type Vault, type VaultConfig, type PageTypesConfig } from "./vault";
export { makeDocument, type Document, type DocumentCategory, type DocumentInput } from "./document";
export type { HookContext, HookHandler, HookEvent, ReadonlyToolSurface } from "./hook-context";
export type {
  Result,
  Effect,
  ToolReturn,
  ToolError,
  LogEntry,
  LogVerb,
  Sensitivity,
  CreationReason,
  InvariantName,
  WikiLink,
  SearchMatch,
} from "./types";
export { INVARIANTS } from "./types";

export { readDocument } from "./tools/read-document";
export { writeDocument } from "./tools/write-document";
export { appendLog } from "./tools/append-log";
export { searchIndex } from "./tools/search-index";
export { wikilinkResolve } from "./tools/wikilink-resolve";
export { moveDocument } from "./tools/move-document";
export { deleteDocument } from "./tools/delete-document";

export { makeDispatcher, type Dispatcher, type IndexEntry } from "./dispatcher";

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
