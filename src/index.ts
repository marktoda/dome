// Public API surface — @dome/sdk v1.0.
//
// The canonical write path is git: clients commit markdown to `main`, and
// the engine watches the branch (via `dome serve`) and runs adoption when
// it sees new commits. There is NO public submit-style API — Proposals are
// constructed internally by the daemon. Per docs/v1.md §13.2: "Claude Code
// does not need bespoke write tools."
//
// What this surface exposes:
//   - The four-concept core types (Vault / Proposal / Processor / Effect).
//   - Effect constructors (for processor authors).
//   - Processor authoring helpers (`defineProcessor`).
//   - The adopted-ref read accessors.
//   - The bundle loader (for the daemon and for tests).
//
// What this surface does NOT expose:
//   - submitProposal — internal to the daemon.
//   - The Proposal constructors — internal; the daemon synthesizes from
//     working-tree drift.
//   - openVaultRuntime — internal to the daemon.
//   - commitWorkflow / raw DB openers — internal write-capable handles.
//
// Per [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]], this
// entrypoint depends on no LLM SDK, MCP transport, or HTTP framework.

// ----- Core types: Result + ToolError ---------------------------------------

export type { Result, ToolError } from "./types";
export { ok, err } from "./types";

// ----- Core domain types (proposals, effects, processors, source refs) ------

export type {
  Proposal,
  ProposalSource,
  AdoptionResult,
} from "./core/proposal";

export type {
  Effect,
  PatchEffect,
  PatchEffectInput,
  FileChange,
  FileChangeInput,
  NodeRef,
  DiagnosticEffect,
  FactEffect,
  FactEffectInput,
  QuestionEffect,
  ViewEffect,
  JobEffect,
  ExternalActionEffect,
  OutboxRecoveryEffect,
  QuarantineRecoveryEffect,
  RunRecoveryEffect,
  NodeRefInput,
} from "./core/effect";
export {
  patchEffect,
  diagnosticEffect,
  factEffect,
  questionEffect,
  viewEffect,
  jobEffect,
  externalActionEffect,
  outboxRecoveryEffect,
  quarantineRecoveryEffect,
  runRecoveryEffect,
} from "./core/effect";

export type {
  Capability,
  Processor,
  ProcessorContext,
  ProcessorPhase,
  Trigger,
  TreeOid,
  ModelInvokeFn,
  ModelInvokeTextInput,
  ModelInvokeStructuredInput,
} from "./core/processor";
export { defineProcessor, treeOid } from "./core/processor";
export type { TransientProcessorError } from "./core/processor-error";
export { transientProcessorError } from "./core/processor-error";

export type { CommitOid, SourceRef, SourceRefInput } from "./core/source-ref";
export { commitOid } from "./core/source-ref";
export type { VaultPath } from "./core/vault-path";

// ----- Engine-internal types kept on the public type surface ---------------
//
// `EngineVault` is the minimal structural type `adopt()` consumes (per
// [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]] §"engine reads vault by
// shape, not by class"). The type is re-exported so consumers constructing
// an EngineVault outside the daemon (advanced harnesses, integration tests)
// can name the shape; the constructor / submission paths are not exposed.

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

// ----- Engine commit-trailer helpers ----------------------------------------
//
// `composeCommitMessage` is pure and exposed for tests/tools that need to
// render the Dome trailer shape. `commitWorkflow` is intentionally internal:
// it performs a real git commit and is part of the engine write boundary.

export { composeCommitMessage, type WorkflowCommitInput } from "./workflow-commit";
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
// advance it only as a side effect of the daemon's adoption runs.

export { getAdoptedRef, getCurrentBranch, adoptedRefName } from "./adopted-ref";
