// dispatchGardenRun — the shared dispatch+route mechanism for one *garden run*:
// a single non-signal garden-phase processor invocation (a schedule fire or
// an answer handler), dispatched against the adopted snapshot outside the
// adoption loop and routed via routeGardenRunEffects.
//
// Before this module each of scheduler/answers repeated the snapshot
// construction + the dispatchOneProcessor option spread + the
// routeGardenRunEffects option spread verbatim, so every new runtime
// dependency had to be threaded through both runners in lockstep. This module
// owns that envelope; the runners keep only their eligibility selection, crash
// policy, and bookkeeping.
//
// The signal-triggered garden pass (garden.ts) is deliberately NOT a caller:
// it runs many processors in one phase and batches their patches into a single
// spawn queue before emitting one batched cascade-cap diagnostic. It already
// shares the deepest chokepoint (spawnGardenSubProposal). See docs/glossary.md
// "Garden run".

import type { DiagnosticEffect } from "../../core/effect";
import type {
  Capability,
  ExtensionConfig,
  OperationalQueryView,
  Processor,
  TreeOid,
} from "../../core/processor";
import type { CommitOid } from "../../core/source-ref";
import type { LedgerDb } from "../../ledger/db";
import { dispatchOneProcessor, makeSnapshot } from "../../processors/runtime";
import type { ExecutionPolicyCap } from "../../processors/execution-policy";
import type { ProcessorExecutionState } from "../../processors/execution-state";
import type { TriggerMatch } from "../../processors/triggers";
import { resolveCurrentAdopted } from "../core/adoption-status";
import type { ApplyEffectSinks } from "../core/apply-effect";
import { applyPatchToCandidate, type ApplyPatchInput } from "../core/apply-patch";
import type { ModelProvider, ModelStepProvider } from "../core/model-invoke";
import type { RunnerResult } from "../core/runner-contract";
import type { EngineVault } from "../core/vault-shape";
import {
  routeGardenRunEffects,
  type GardenRunEffectRoutingSummary,
} from "./garden-run-routing";
import type { AdoptSubProposalFn } from "./garden-sub-proposals";

/** The shared runtime plumbing a garden run needs — built once, threaded once. */
export type GardenRunDeps = {
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly currentAdopted?: () => CommitOid;
  readonly resolveTree: (commit: CommitOid) => Promise<TreeOid>;
  readonly sinks: ApplyEffectSinks;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly extensionConfigFor?: (extensionId: string) => ExtensionConfig;
  readonly ledger: LedgerDb;
  readonly executionState?: ProcessorExecutionState;
  readonly executionCap?: ExecutionPolicyCap;
  readonly modelProvider?: ModelProvider;
  readonly modelStepProvider?: ModelStepProvider;
  readonly operational?: OperationalQueryView;
  readonly signal?: AbortSignal;
  /** Clock forwarded to routeGardenRunEffects (sub-Proposal timestamping). */
  readonly now?: () => Date;
  /**
   * Optional override for the garden-patch applier. dispatchGardenRun resolves
   * the `?? applyPatchToCandidate` default internally, so the default lives in
   * one place and no caller has to thread it.
   */
  readonly applyGardenPatchToCandidate?: (
    opts: ApplyPatchInput,
  ) => Promise<CommitOid | null>;
  readonly adoptSubProposal?: AdoptSubProposalFn;
};

/** The per-run specifics — the only things that vary across the two sources. */
export type GardenRun = {
  readonly processor: Processor<unknown>;
  readonly phase: "adoption" | "garden" | "view";
  readonly envelope: unknown;
  readonly matches: ReadonlyArray<TriggerMatch>;
  readonly disabledDiagnostic: {
    readonly code: string;
    readonly message: string;
  };
  /**
   * The Date forwarded to dispatchOneProcessor (its run-ledger startedAt).
   * Schedule fires pin one instant (the runner computed it once for cursor
   * math + envelope.firedAt); answers omit it, leaving the dispatch layer's
   * internal default.
   */
  readonly now?: Date;
};

export type GardenRunOutcome = {
  readonly result: RunnerResult;
  readonly routing: GardenRunEffectRoutingSummary;
};

/**
 * Dispatch one garden run against the adopted snapshot and route its effects.
 * Resolves the input commit at call time (so per-fire re-resolution of
 * currentAdopted is preserved), builds the snapshot, dispatches the processor,
 * then routes effects through routeGardenRunEffects. The `diagnostics`
 * accumulator is the caller's run-level array; routeGardenRunEffects appends to
 * it (and the caller's crash handler may too).
 */
export async function dispatchGardenRun(
  deps: GardenRunDeps,
  run: GardenRun,
  diagnostics: DiagnosticEffect[],
): Promise<GardenRunOutcome> {
  const applyGardenPatch =
    deps.applyGardenPatchToCandidate ?? applyPatchToCandidate;
  const inputAdopted = resolveCurrentAdopted(deps.currentAdopted, deps.adopted);
  const snapshot = await makeSnapshot(
    deps.vault.path,
    inputAdopted,
    deps.resolveTree,
  );

  const result = await dispatchOneProcessor({
    processor: run.processor,
    phase: run.phase,
    envelope: run.envelope,
    snapshot,
    changedPaths: Object.freeze([]),
    proposal: null,
    inputCommit: inputAdopted,
    matches: run.matches,
    resolveGrants: deps.resolveGrants,
    extensionIdFor: deps.extensionIdFor,
    ledger: deps.ledger,
    ...(run.now !== undefined ? { now: run.now } : {}),
    ...(deps.extensionConfigFor !== undefined
      ? { extensionConfigFor: deps.extensionConfigFor }
      : {}),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    ...(deps.executionState !== undefined
      ? { executionState: deps.executionState }
      : {}),
    ...(deps.executionCap !== undefined
      ? { executionCap: deps.executionCap }
      : {}),
    ...(deps.modelProvider !== undefined
      ? { modelProvider: deps.modelProvider }
      : {}),
    ...(deps.modelStepProvider !== undefined
      ? { modelStepProvider: deps.modelStepProvider }
      : {}),
    ...(deps.operational !== undefined ? { operational: deps.operational } : {}),
  });

  const routing = await routeGardenRunEffects({
    result,
    vault: deps.vault,
    adopted: inputAdopted,
    ...(deps.currentAdopted !== undefined
      ? { currentAdopted: deps.currentAdopted }
      : {}),
    proposalId: null,
    sinks: deps.sinks,
    diagnostics,
    applyGardenPatch,
    extensionIdFor: deps.extensionIdFor,
    ledger: deps.ledger,
    ...(deps.adoptSubProposal !== undefined
      ? { adoptSubProposal: deps.adoptSubProposal }
      : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    disabledDiagnostic: run.disabledDiagnostic,
  });

  return Object.freeze({ result, routing });
}
