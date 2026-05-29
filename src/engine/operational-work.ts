// engine/operational-work: one pump for non-adoption engine work.
//
// Adoption owns trusted-state convergence. This module owns the adjacent
// operational queues that should make progress once trusted state is stable:
// due schedule triggers, durable JobEffect rows, and pending outbox rows.
// The outbox drain is bounded to rows that were already pending before
// this pump started, so external effects created by scheduler/job work
// do not get an immediate same-pump retry after a transient failure.
// Keeping the pump explicit prevents each caller (`sync`, `serve`, tests,
// future close/drain) from inventing its own partial lifecycle.

import type { DiagnosticEffect } from "../core/effect";
import type {
  Capability,
  OperationalQueryView,
  TreeOid,
} from "../core/processor";
import type { AdoptionResult, Proposal } from "../core/proposal";
import type { CommitOid } from "../core/source-ref";
import type { LedgerDb } from "../ledger/db";
import {
  dispatchPendingOutbox,
  type ExternalDispatchResult,
  type ExternalHandlerRegistry,
} from "../outbox/dispatch";
import type { OutboxDb } from "../outbox/db";
import type { ProjectionDb } from "../projections/db";
import type { ExecutionPolicyCap } from "../processors/execution-policy";
import type { ProcessorExecutionState } from "../processors/execution-state";
import type { ProcessorRegistry } from "../processors/registry";
import type { ModelProvider } from "./model-invoke";
import type { ApplyEffectSinks } from "./apply-effect";
import type { ApplyPatchInput } from "./apply-patch";
import { runQueuedJobs, type JobDrainResult } from "./jobs";
import { runScheduler, type SchedulerResult } from "./scheduler";
import type { EngineVault } from "./vault-shape";

export type OperationalWorkResult = {
  readonly scheduler: SchedulerResult;
  readonly jobs: JobDrainResult;
  readonly outbox: ReadonlyArray<ExternalDispatchResult>;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
};

export async function runOperationalWork(opts: {
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly registry: ProcessorRegistry;
  readonly projection: ProjectionDb;
  readonly outbox: OutboxDb;
  readonly sinks: ApplyEffectSinks;
  readonly resolveTree: (commit: CommitOid) => Promise<TreeOid>;
  readonly now: () => Date;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly externalHandlers: ExternalHandlerRegistry;
  readonly operational?: OperationalQueryView;
  readonly ledger?: LedgerDb;
  readonly executionState?: ProcessorExecutionState;
  readonly executionCap?: ExecutionPolicyCap;
  readonly modelProvider?: ModelProvider;
  readonly adoptSubProposal?: (
    proposal: Proposal,
    cascadeDepth: number,
  ) => Promise<AdoptionResult>;
  readonly currentAdopted?: () => CommitOid;
  readonly applyGardenPatchToCandidate?: (
    opts: ApplyPatchInput,
  ) => Promise<CommitOid | null>;
}): Promise<OperationalWorkResult> {
  const outboxNow = opts.now();
  const outboxDrainCutoff = outboxNow;

  const scheduler = await runScheduler({
    vault: opts.vault,
    adopted: opts.adopted,
    registry: opts.registry,
    projection: opts.projection,
    sinks: opts.sinks,
    resolveTree: opts.resolveTree,
    now: opts.now,
    resolveGrants: opts.resolveGrants,
    extensionIdFor: opts.extensionIdFor,
    ...(opts.ledger !== undefined ? { ledger: opts.ledger } : {}),
    ...(opts.executionState !== undefined
      ? { executionState: opts.executionState }
      : {}),
    ...(opts.executionCap !== undefined
      ? { executionCap: opts.executionCap }
      : {}),
    ...(opts.modelProvider !== undefined
      ? { modelProvider: opts.modelProvider }
      : {}),
    ...(opts.operational !== undefined ? { operational: opts.operational } : {}),
    ...(opts.adoptSubProposal !== undefined
      ? { adoptSubProposal: opts.adoptSubProposal }
      : {}),
    ...(opts.currentAdopted !== undefined
      ? { currentAdopted: opts.currentAdopted }
      : {}),
    ...(opts.applyGardenPatchToCandidate !== undefined
      ? { applyGardenPatchToCandidate: opts.applyGardenPatchToCandidate }
      : {}),
  });

  const jobs = await runQueuedJobs({
    vault: opts.vault,
    adopted: opts.adopted,
    registry: opts.registry,
    projection: opts.projection,
    sinks: opts.sinks,
    resolveTree: opts.resolveTree,
    now: opts.now,
    resolveGrants: opts.resolveGrants,
    extensionIdFor: opts.extensionIdFor,
    ...(opts.ledger !== undefined ? { ledger: opts.ledger } : {}),
    ...(opts.executionState !== undefined
      ? { executionState: opts.executionState }
      : {}),
    ...(opts.executionCap !== undefined
      ? { executionCap: opts.executionCap }
      : {}),
    ...(opts.modelProvider !== undefined
      ? { modelProvider: opts.modelProvider }
      : {}),
    ...(opts.operational !== undefined ? { operational: opts.operational } : {}),
    ...(opts.adoptSubProposal !== undefined
      ? { adoptSubProposal: opts.adoptSubProposal }
      : {}),
    ...(opts.currentAdopted !== undefined
      ? { currentAdopted: opts.currentAdopted }
      : {}),
    ...(opts.applyGardenPatchToCandidate !== undefined
      ? { applyGardenPatchToCandidate: opts.applyGardenPatchToCandidate }
      : {}),
  });

  const outbox = await dispatchPendingOutbox(opts.outbox, {
    handlers: opts.externalHandlers,
    enqueuedBefore: outboxDrainCutoff,
    now: outboxNow,
  });

  return Object.freeze({
    scheduler,
    jobs,
    outbox,
    diagnostics: Object.freeze([
      ...scheduler.diagnostics,
      ...jobs.diagnostics,
    ]),
  });
}
