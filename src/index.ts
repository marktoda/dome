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
//   - The three DB-open functions (for harnesses that want to query the
//     projection / outbox / ledger directly).
//   - The adopted-ref read accessors.
//   - The commit-trailer chokepoint (for advanced commit construction).
//   - The bundle loader (for the daemon and for tests).
//
// What this surface does NOT expose:
//   - submitProposal — internal to the daemon.
//   - The Proposal constructors — internal; the daemon synthesizes from
//     working-tree drift.
//   - openVaultRuntime — internal to the daemon.
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
  FileChange,
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
// advance it only as a side effect of the daemon's adoption runs.

export { getAdoptedRef, getCurrentBranch, adoptedRefName } from "./adopted-ref";

// ----- Projection / outbox / ledger query surface ---------------------------
//
// The three DBs are the v1 read surface for diagnostics, facts, questions,
// jobs, capability-use audit history, and the unprocessed-event outbox.
// The daemon (Phase 11b) is the open-side; these query functions accept the
// opened handles directly.

export type { ProjectionDb } from "./projections/db";
export { openProjectionDb } from "./projections/db";

export type { OutboxDb } from "./outbox/db";
export { openOutboxDb } from "./outbox/db";

export type { LedgerDb } from "./ledger/db";
export { openLedgerDb } from "./ledger/db";
