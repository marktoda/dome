// engine/jobs: drain JobEffect rows as garden-phase processor invocations.
//
// JobEffect is the deferred-work boundary: a processor asks the engine to run
// another processor later, with a fresh RunRecord and the target processor's
// own capability scope. The projection store owns persistence; this module
// owns the engine lifecycle around due jobs.

import { diagnosticEffect, type DiagnosticEffect, type PatchEffect } from "../core/effect";
import {
  makeGardenProposal,
  proposalMetadata,
  type AdoptionResult,
  type Proposal,
} from "../core/proposal";
import type { CommitOid } from "../core/source-ref";
import type { Capability, Processor, TreeOid } from "../core/processor";
import { recordCapabilityUse } from "../ledger/capability-uses";
import type { LedgerDb } from "../ledger/db";
import {
  claimNextEligibleJob,
  markJobFailed,
  markJobPending,
  markJobSucceeded,
  type ScheduledJobRow,
} from "../projections/jobs";
import type { ProjectionDb } from "../projections/db";
import type { ProcessorRegistry } from "../processors/registry";
import {
  dispatchOneProcessor,
  makeSnapshot,
} from "../processors/runtime";
import type { ProcessorExecutionState } from "../processors/execution-state";
import type { ModelProvider } from "./model-invoke";
import type { TriggerMatch } from "../processors/triggers";
import type { ApplyEffectSinks } from "./apply-effect";
import { applyEffect } from "./apply-effect";
import {
  applyPatchToCandidate,
  type ApplyPatchInput,
} from "./apply-patch";
import { routeGardenPatchForSubProposal } from "./garden-patch-router";
import type { RunId } from "./runner-contract";
import type { EngineVault } from "./vault-shape";

const DEFAULT_MAX_JOBS_PER_DRAIN = 100;
const MAX_RETRY_DELAY_MS = 60_000;

type AdoptJobSubProposalFn = (
  proposal: Proposal,
  cascadeDepth: number,
) => Promise<AdoptionResult>;

export type JobDrainResult = {
  readonly drained: ReadonlyArray<JobDrainSummary>;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
};

export type JobDrainSummary = {
  readonly jobId: number;
  readonly processorId: string;
  readonly status: "succeeded" | "failed" | "rescheduled";
  readonly runId: RunId | null;
};

export async function runQueuedJobs(opts: {
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly registry: ProcessorRegistry;
  readonly projection: ProjectionDb;
  readonly sinks: ApplyEffectSinks;
  readonly resolveTree: (commit: CommitOid) => Promise<TreeOid>;
  readonly now: () => Date;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly ledger?: LedgerDb;
  readonly executionState?: ProcessorExecutionState;
  readonly modelProvider?: ModelProvider;
  readonly adoptSubProposal?: AdoptJobSubProposalFn;
  readonly applyGardenPatchToCandidate?: (
    opts: ApplyPatchInput,
  ) => Promise<CommitOid | null>;
  readonly maxJobs?: number;
}): Promise<JobDrainResult> {
  const maxJobs = opts.maxJobs ?? DEFAULT_MAX_JOBS_PER_DRAIN;
  const drained: JobDrainSummary[] = [];
  const diagnostics: DiagnosticEffect[] = [];
  const applyGardenPatch =
    opts.applyGardenPatchToCandidate ?? applyPatchToCandidate;

  for (let i = 0; i < maxJobs; i += 1) {
    const job = claimNextEligibleJob(opts.projection, opts.now());
    if (job === null) break;

    const processor = opts.registry.get(job.processorId);
    if (processor === undefined || processor.phase !== "garden") {
      markJobFailed(opts.projection, job.id, opts.now());
      diagnostics.push(
        diagnosticEffect({
          severity: "error",
          code: "job.target-unavailable",
          message: `Job ${job.id} targets '${job.processorId}', but no garden-phase processor with that id is registered.`,
          sourceRefs: [],
        }),
      );
      drained.push(
        Object.freeze({
          jobId: job.id,
          processorId: job.processorId,
          status: "failed" as const,
          runId: null,
        }),
      );
      continue;
    }

    try {
      const result = await runOneJob({
        ...opts,
        job,
        processor,
        diagnostics,
        applyGardenPatch,
      });
      drained.push(result);
    } catch (e) {
      drained.push(
        recoverCrashedClaimedJob({
          projection: opts.projection,
          job,
          now: opts.now,
          diagnostics,
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  return Object.freeze({
    drained: Object.freeze(drained),
    diagnostics: Object.freeze(diagnostics),
  });
}

async function runOneJob(opts: {
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly projection: ProjectionDb;
  readonly sinks: ApplyEffectSinks;
  readonly resolveTree: (commit: CommitOid) => Promise<TreeOid>;
  readonly now: () => Date;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly ledger?: LedgerDb;
  readonly executionState?: ProcessorExecutionState;
  readonly modelProvider?: ModelProvider;
  readonly adoptSubProposal?: AdoptJobSubProposalFn;
  readonly job: ScheduledJobRow;
  readonly processor: Processor<unknown>;
  readonly diagnostics: DiagnosticEffect[];
  readonly applyGardenPatch: (opts: ApplyPatchInput) => Promise<CommitOid | null>;
}): Promise<JobDrainSummary> {
  const snapshot = await makeSnapshot(opts.vault.path, opts.adopted, opts.resolveTree);
  const matches: ReadonlyArray<TriggerMatch> = Object.freeze([
    Object.freeze({
      trigger: Object.freeze({
        kind: "job" as const,
        idempotencyKey: opts.job.idempotencyKey,
      }),
      matchedSignals: Object.freeze([]),
    }),
  ]);

  const result = await dispatchOneProcessor({
    processor: opts.processor,
    phase: "garden",
    envelope: opts.job.input,
    snapshot,
    changedPaths: Object.freeze([]),
    proposal: null,
    inputCommit: opts.adopted,
    matches,
    resolveGrants: opts.resolveGrants,
    extensionIdFor: opts.extensionIdFor,
    ledger: opts.ledger,
    ...(opts.executionState !== undefined
      ? { executionState: opts.executionState }
      : {}),
    ...(opts.modelProvider !== undefined
      ? { modelProvider: opts.modelProvider }
      : {}),
  });

  for (const effect of result.effects) {
    if (effect.kind === "patch") {
      await routeJobGardenPatch({
        effect,
        vault: opts.vault,
        adopted: opts.adopted,
        processorId: result.processorId,
        runId: result.runId,
        declared: result.declared,
        granted: result.granted,
        sinks: opts.sinks,
        diagnostics: opts.diagnostics,
        extensionId: opts.extensionIdFor(result.processorId),
        applyGardenPatch: opts.applyGardenPatch,
        ...(opts.ledger !== undefined ? { ledger: opts.ledger } : {}),
        ...(opts.adoptSubProposal !== undefined
          ? { adoptSubProposal: opts.adoptSubProposal }
          : {}),
      });
      continue;
    }

    const applied = await applyEffect({
      effect,
      processorId: result.processorId,
      runId: result.runId,
      proposalId: null,
      phase: "garden",
      declared: result.declared,
      granted: result.granted,
      sinks: opts.sinks,
      candidate: opts.adopted,
    });
    if (applied.diagnostics.length > 0) {
      opts.diagnostics.push(...applied.diagnostics);
    }
    if (opts.ledger !== undefined && applied.capabilityUse !== undefined) {
      recordCapabilityUse(opts.ledger, {
        runId: result.runId,
        capability: applied.capabilityUse.capability,
        resource: applied.capabilityUse.resource,
        outcome: applied.capabilityUse.outcome,
        recordedAt: new Date(),
      });
    }
  }

  if (result.executionStatus === "succeeded") {
    markJobSucceeded(opts.projection, opts.job.id, opts.now());
    return Object.freeze({
      jobId: opts.job.id,
      processorId: opts.job.processorId,
      status: "succeeded" as const,
      runId: result.runId,
    });
  }

  if (result.executionError?.code === "processor.quarantined") {
    markJobFailed(opts.projection, opts.job.id, opts.now());
    return Object.freeze({
      jobId: opts.job.id,
      processorId: opts.job.processorId,
      status: "failed" as const,
      runId: result.runId,
    });
  }

  if (result.executionError?.retryable !== true) {
    markJobFailed(opts.projection, opts.job.id, opts.now());
    return Object.freeze({
      jobId: opts.job.id,
      processorId: opts.job.processorId,
      status: "failed" as const,
      runId: result.runId,
    });
  }

  const attemptsAfterRun = opts.job.attempts;
  if (attemptsAfterRun >= opts.job.maxAttempts) {
    markJobFailed(opts.projection, opts.job.id, opts.now());
    return Object.freeze({
      jobId: opts.job.id,
      processorId: opts.job.processorId,
      status: "failed" as const,
      runId: result.runId,
    });
  }

  markJobPending(
    opts.projection,
    opts.job.id,
    new Date(opts.now().getTime() + retryDelayMs(attemptsAfterRun)),
  );
  return Object.freeze({
    jobId: opts.job.id,
    processorId: opts.job.processorId,
    status: "rescheduled" as const,
    runId: result.runId,
  });
}

function recoverCrashedClaimedJob(opts: {
  readonly projection: ProjectionDb;
  readonly job: ScheduledJobRow;
  readonly now: () => Date;
  readonly diagnostics: DiagnosticEffect[];
  readonly message: string;
}): JobDrainSummary {
  const retry = opts.job.attempts < opts.job.maxAttempts;
  opts.diagnostics.push(
    diagnosticEffect({
      severity: "error",
      code: "job.dispatch-crashed",
      message: `Job ${opts.job.id} dispatch crashed before completion: ${opts.message}`,
      sourceRefs: [],
    }),
  );
  if (retry) {
    markJobPending(
      opts.projection,
      opts.job.id,
      new Date(opts.now().getTime() + retryDelayMs(opts.job.attempts)),
    );
    return Object.freeze({
      jobId: opts.job.id,
      processorId: opts.job.processorId,
      status: "rescheduled" as const,
      runId: null,
    });
  }

  markJobFailed(opts.projection, opts.job.id, opts.now());
  return Object.freeze({
    jobId: opts.job.id,
    processorId: opts.job.processorId,
    status: "failed" as const,
    runId: null,
  });
}

async function routeJobGardenPatch(opts: {
  readonly effect: PatchEffect;
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly processorId: string;
  readonly runId: RunId;
  readonly declared: ReadonlyArray<Capability>;
  readonly granted: ReadonlyArray<Capability>;
  readonly sinks: ApplyEffectSinks;
  readonly ledger?: LedgerDb;
  readonly diagnostics: DiagnosticEffect[];
  readonly adoptSubProposal?: AdoptJobSubProposalFn;
  readonly applyGardenPatch: (opts: ApplyPatchInput) => Promise<CommitOid | null>;
  readonly extensionId: string;
}): Promise<void> {
  const routed = await routeGardenPatchForSubProposal({
    effect: opts.effect,
    processorId: opts.processorId,
    runId: opts.runId,
    proposalId: null,
    declared: opts.declared,
    granted: opts.granted,
    sinks: opts.sinks,
    ...(opts.ledger !== undefined ? { ledger: opts.ledger } : {}),
  });
  opts.diagnostics.push(...routed.diagnostics);
  if (routed.kind === "dropped") return;
  if (opts.adoptSubProposal === undefined) return;

  const newHead = await opts.applyGardenPatch({
    vaultPath: opts.vault.path,
    candidate: opts.adopted,
    patch: routed.patch,
    runContext: {
      runId: opts.runId,
      processorId: opts.processorId,
      extensionId: opts.extensionId,
      base: opts.adopted,
      sourceHead: opts.adopted,
    },
  });
  if (newHead === null) return;

  const subProposal = makeGardenProposal({
    base: opts.adopted,
    head: newHead,
    processorId: opts.processorId,
    runId: opts.runId,
    metadata: proposalMetadata({ reason: routed.patch.reason }),
  });
  await opts.adoptSubProposal(subProposal, 1);
}

function retryDelayMs(attemptsAfterRun: number): number {
  const delay = 1000 * 2 ** Math.max(0, attemptsAfterRun - 1);
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}
