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

// Stage 3: prompts + workflows + eval
export { WorkflowName, WORKFLOW_NAMES, isWorkflowName } from "./workflows/workflow-name";
export { WorkflowTier, WORKFLOW_TIERS } from "./workflows/workflow-tier";
export { AgentLoop, AGENT_LOOP_MAX_TURNS, type LlmClient, type LlmTurn } from "./workflows/agent-loop";
export { AnthropicLlmClient, type AnthropicLlmOpts } from "./workflows/anthropic-client";
export { PromptLoader, PromptSource, type LoadedPrompt } from "./prompts/prompt-loader";
export { WorkflowRegistry, type WorkflowDefinition } from "./prompts/registry";
export {
  parseWorkflowFrontmatter,
  isWorkflowPrompt,
  WorkflowFrontmatterSchema,
  type WorkflowFrontmatter,
} from "./prompts/workflow-frontmatter";
export { makeFixtureVault, type Fixture, type EvalFixtureVault } from "./eval/fixture-vault";
export { replay, type ReplayCase, type ReplayResult, type ExpectedEffects } from "./eval/replay";
