// Public API surface — @dome/sdk v1.
//
// Phase 7b retired the v0.5 Tools-surface (writeDocument, patchRegion, etc.),
// the hooks dispatcher, the workflow runner, the MCP server, the CLI, the
// prompts surface, the eval harness, and the bundle loader. What remains is
// the v1 substrate: the proposal-construction layer, the engine entry point
// (`submitProposal` + `openVaultRuntime`), the projection / outbox / ledger
// query surface, the adopted-ref read accessors, and the engine commit-
// trailer chokepoint.
//
// Per [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]], every write
// into trusted vault state flows through `submitProposal`. The five
// constructor functions (`clientProposal`, `agentProposal`, `gardenProposal`,
// `manualProposal`, `importProposal`) are the only paths to a valid Proposal.
//
// Per [[wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY]], this entrypoint
// does NOT depend on any LLM SDK, MCP transport, or HTTP framework.

// ----- Core types: Result + ToolError ---------------------------------------

export type { Result, ToolError } from "./types";
export { ok, err } from "./types";

// ----- Core domain types (proposals, effects, processors, source refs) ------

export type {
  Proposal,
  ProposalSource,
  ClientSource,
  AgentSource,
  GardenSource,
  ManualSource,
  ImportSource,
  AdoptionResult,
  SubmitInput,
} from "./core/proposal";
export {
  clientProposal,
  agentProposal,
  gardenProposal,
  manualProposal,
  importProposal,
} from "./core/proposal";

export type {
  Effect,
  PatchEffect,
  DiagnosticEffect,
  FactEffect,
  QuestionEffect,
  ViewEffect,
  JobEffect,
  ExternalActionEffect,
} from "./core/effect";
export {
  patchEffect,
  diagnosticEffect,
  factEffect,
  questionEffect,
  viewEffect,
  jobEffect,
  externalActionEffect,
} from "./core/effect";

export type {
  Capability,
  Processor,
  ProcessorContext,
  ProcessorPhase,
  Trigger,
  TreeOid,
} from "./core/processor";
export { defineProcessor, treeOid } from "./core/processor";

export type { CommitOid } from "./core/source-ref";
export { commitOid } from "./core/source-ref";

// ----- Engine entry point ---------------------------------------------------

export { submitProposal, type SubmitProposalOpts } from "./engine/submit-proposal";
export {
  openVaultRuntime,
  type VaultRuntime,
  type OpenVaultRuntimeOpts,
  type OpenVaultRuntimeWithRegistryOpts,
  type OpenVaultRuntimeWithBundlesOpts,
  type OpenVaultRuntimeError,
} from "./engine/vault-runtime";
export type { EngineVault } from "./engine/vault-shape";

// ----- Extension bundle loader ---------------------------------------------

export {
  loadBundles,
  flattenBundleProcessors,
  type LoadedBundle,
  type LoadBundlesOpts,
  type LoadBundlesError,
} from "./extensions/loader";
export {
  parseManifest,
  ManifestSchema,
  ProcessorDeclarationSchema,
  type Manifest,
  type ProcessorDeclaration,
  type ManifestError,
  type TriggerKind,
} from "./extensions/manifest-schema";

// ----- Engine commit-trailer chokepoint -------------------------------------
//
// `commitWorkflow` + `composeCommitMessage` are the structural fence behind
// [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]]. `makeRunContext`
// + the four Dome-* constants belong here so callers constructing a
// RunContext don't have to import a separate package.

export {
  commitWorkflow,
  composeCommitMessage,
  type WorkflowCommitInput,
} from "./workflow-commit";
export {
  makeRunContext,
  ENGINE_EXTENSION_ID,
  ZERO_SHA,
  type RunContext,
} from "./run-context";

// ----- Adopted-ref read surface ---------------------------------------------
//
// Per [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]], the adopted-ref
// write side (`setAdoptedRef`) is INTERNAL to the engine's adoption loop and
// intentionally NOT re-exported. Consumers reach the adopted ref via the
// read accessors (`getAdoptedRef`, `getCurrentBranch`, `adoptedRefName`) and
// advance it only as a side effect of `submitProposal`.

export { getAdoptedRef, getCurrentBranch, adoptedRefName } from "./adopted-ref";

// ----- Projection / outbox / ledger query surface ---------------------------
//
// The three DBs are the v1 read surface for diagnostics, facts, questions,
// jobs, capability-use audit history, and the unprocessed-event outbox.
// `openVaultRuntime` is the open-side; these query functions accept the
// opened handles directly.

export type { ProjectionDb } from "./projections/db";
export { openProjectionDb } from "./projections/db";

export type { OutboxDb } from "./outbox/db";
export { openOutboxDb } from "./outbox/db";

export type { LedgerDb } from "./ledger/db";
export { openLedgerDb } from "./ledger/db";
