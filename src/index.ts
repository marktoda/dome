// Public API surface — what plugin and harness authors consume.

export { openVault, type Vault, type VaultConfig, type PageTypesConfig, type BoundToolSurface } from "./vault";
export { makeDocument, type Document, type DocumentCategory, type DocumentInput } from "./document";
export type { HookContext, HookHandler, HookEvent } from "./hook-context";
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

// The privileged-writer type (writeIndex / appendLogEntry / removeIndexEntry)
// is INTENTIONALLY NOT exported. Plugin and vault-local code reach it only via
// `HookContext.privilegedWriter`, which the hook-dispatcher partitions to
// sdk-source hooks — this is the structural enforcement layer for
// INDEX_AND_LOG_ARE_DISPATCHER_OWNED. See:
//   docs/wiki/invariants/INDEX_AND_LOG_ARE_DISPATCHER_OWNED.md
// IndexEntry is exposed indirectly via the writer's method signatures on
// HookContext; consumers that need the shape import it from there.
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

// Stage 3: prompts + workflows + eval
export { WorkflowName, WORKFLOW_NAMES, isWorkflowName } from "./workflows/workflow-name";
export { WorkflowTier, WORKFLOW_TIERS } from "./workflows/workflow-tier";
export {
  runWorkflow,
  buildAiSdkTools,
  DEFAULT_MODEL,
  DEFAULT_MAX_STEPS,
  type RunWorkflowOpts,
  type RunWorkflowResult,
} from "./workflows/agent-loop";
export { PromptLoader, PromptSource, type LoadedPrompt } from "./prompts/prompt-loader";
export { WorkflowRegistry, type WorkflowDefinition } from "./prompts/registry";
export {
  parseWorkflowFrontmatter,
  isWorkflowPrompt,
  WorkflowFrontmatterSchema,
  type WorkflowFrontmatter,
} from "./prompts/workflow-frontmatter";
export { makeFixtureVault, type Fixture, type EvalFixtureVault } from "./eval/fixture-vault";
// replay is @internal — eval harness used by tests; not part of the v0.5 public
// SDK. Consumers needing programmatic workflow execution should depend on
// `runWorkflow` directly. See src/eval/replay.ts.

// Canonical Tool registry — single source of truth for the seven Tools.
// Plugin and harness authors that want to enumerate or extend the Tool
// surface (v1+) consume these.
export {
  TOOL_NAMES,
  MCP_TOOL_NAMES,
  MUTATING_TOOL_NAMES,
  filterAiTools,
  type ToolName,
} from "./tools/registry";

// Stage 4: MCP server + CLI
// `McpToolName` (PascalCase keyed object) is a backwards-compat alias over
// `MCP_TOOL_NAMES` above; both re-export the same canonical strings.
export { McpToolName } from "./mcp/tool-names";
export { buildToolAdapters, type ToolAdapter } from "./mcp/tool-adapters";
export { buildPromptAdapters, type PromptAdapter } from "./mcp/prompt-adapters";
export { ResourceAdapter, ResourceUri, type ResourceContent } from "./mcp/resource-adapters";
export { DomeMcpServer, type DomeMcpServerOpts } from "./mcp/server";
export { DoctorFlag, DOCTOR_FLAGS } from "./cli/doctor-flag";
export { runCli, ExitCode } from "./cli/cli";
export { domeInit } from "./cli/commands/init";
export { domeReconcile } from "./cli/commands/reconcile";
export { domeDoctor, type DoctorReport } from "./cli/commands/doctor";
export { domeLint } from "./cli/commands/lint";
export { domeMigrate } from "./cli/commands/migrate";
export { domeExportContext } from "./cli/commands/export-context";
export { domeServe, type ServeHandle } from "./cli/commands/serve";
