// engine/operational/jobs: drain JobEffect rows as garden-phase processor invocations.
//
// JobEffect is the deferred-work boundary: a processor asks the engine to run
// another processor later, with a fresh RunRecord and the target processor's
// own capability scope. The projection store owns persistence; this module
// owns the engine lifecycle around due jobs.

import {
  diagnosticEffect,
  type DiagnosticEffect,
} from "../../core/effect";
import type { Processor } from "../../core/processor";
import {
  claimNextEligibleJob,
  markJobFailed,
  markJobPending,
  markJobSucceeded,
  recoverExpiredRunningJobs,
  releaseClaimedJob,
  type ScheduledJobRow,
} from "../../projections/jobs";
import type { ProjectionDb } from "../../projections/db";
import type { ProcessorRegistry } from "../../processors/registry";
import type { TriggerMatch } from "../../processors/triggers";
import type { ApplyEffectSinks } from "../core/apply-effect";
import { recordDiagnosticsViaSink } from "../core/diagnostics";
import {
  dispatchGardenRun,
  type GardenRunDeps,
} from "../garden/garden-run";
import type { RunId } from "../core/runner-contract";

const DEFAULT_MAX_JOBS_PER_DRAIN = 100;
const MAX_RETRY_DELAY_MS = 60_000;

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

// Job-drain extras on top of the shared garden-run plumbing. `now` is required
// (job claim + timestamps); the bag carries it as optional.
type JobDrainOptions = GardenRunDeps & {
  readonly registry: ProcessorRegistry;
  readonly projection: ProjectionDb;
  readonly now: () => Date;
  readonly maxJobs?: number;
};

export async function runQueuedJobs(opts: JobDrainOptions): Promise<JobDrainResult> {
  const maxJobs = opts.maxJobs ?? DEFAULT_MAX_JOBS_PER_DRAIN;
  const drained: JobDrainSummary[] = [];
  const diagnostics: DiagnosticEffect[] = [];
  recoverExpiredRunningJobs(opts.projection, opts.now());

  for (let i = 0; i < maxJobs; i += 1) {
    if (opts.signal?.aborted === true) break;

    const job = claimNextEligibleJob(opts.projection, opts.now());
    if (job === null) break;

    const processor = opts.registry.get(job.processorId);
    if (processor === undefined || processor.phase !== "garden") {
      markJobFailed(opts.projection, job.id, opts.now());
      const targetDiag = diagnosticEffect({
        severity: "error",
        code: "job.target-unavailable",
        message: `Job ${job.id} targets '${job.processorId}', but no garden-phase processor with that id is registered.`,
        sourceRefs: [],
      });
      diagnostics.push(targetDiag);
      await recordDiagnosticsViaSink({
        sinks: opts.sinks,
        diagnostics: [targetDiag],
        processorId: "engine.jobs",
        proposalId: null,
      });
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
      });
      drained.push(result);
    } catch (e) {
      drained.push(
        await recoverCrashedClaimedJob({
          projection: opts.projection,
          sinks: opts.sinks,
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

// runOneJob extras on top of the shared garden-run plumbing; `opts` is forwarded
// to dispatchGardenRun untouched (opts ⊇ GardenRunDeps).
type RunOneJobOptions = GardenRunDeps & {
  readonly projection: ProjectionDb;
  readonly now: () => Date;
  readonly job: ScheduledJobRow;
  readonly processor: Processor<unknown>;
  readonly diagnostics: DiagnosticEffect[];
};

async function runOneJob(opts: RunOneJobOptions): Promise<JobDrainSummary> {
  // dispatchGardenRun owns the snapshot + dispatch + route envelope. Queued
  // jobs are not tied to a user-drift Proposal (proposal_id = NULL).
  const matches: ReadonlyArray<TriggerMatch> = Object.freeze([
    Object.freeze({
      trigger: Object.freeze({
        kind: "job" as const,
        idempotencyKey: opts.job.idempotencyKey,
      }),
      matchedSignals: Object.freeze([]),
    }),
  ]);

  const { result } = await dispatchGardenRun(
    opts,
    {
      processor: opts.processor,
      phase: "garden",
      envelope: opts.job.input,
      matches,
      disabledDiagnostic: {
        code: "jobs.garden-sub-proposal-spawn-disabled",
        message:
          `Queued job processor ${opts.processor.id} emitted an authorized ` +
          `PatchEffect, but no adoptSubProposal callback was wired; ` +
          `patch dropped.`,
      },
    },
    opts.diagnostics,
  );

  if (result.executionStatus === "succeeded") {
    markJobSucceeded(opts.projection, opts.job.id, opts.now());
    return Object.freeze({
      jobId: opts.job.id,
      processorId: opts.job.processorId,
      status: "succeeded" as const,
      runId: result.runId,
    });
  }

  if (result.executionStatus === "cancelled") {
    releaseClaimedJob(
      opts.projection,
      opts.job.id,
      new Date(opts.job.runAfter),
    );
    return Object.freeze({
      jobId: opts.job.id,
      processorId: opts.job.processorId,
      status: "rescheduled" as const,
      runId: result.runId,
    });
  }

  // Quarantined processors and non-retryable errors both fail the job
  // terminally with the same failed-result shape.
  if (
    result.executionError?.code === "processor.quarantined" ||
    result.executionError?.retryable !== true
  ) {
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

async function recoverCrashedClaimedJob(opts: {
  readonly projection: ProjectionDb;
  readonly sinks: ApplyEffectSinks;
  readonly job: ScheduledJobRow;
  readonly now: () => Date;
  readonly diagnostics: DiagnosticEffect[];
  readonly message: string;
}): Promise<JobDrainSummary> {
  const retry = opts.job.attempts < opts.job.maxAttempts;
  const dispatchDiag = diagnosticEffect({
    severity: "error",
    code: "job.dispatch-crashed",
    message: `Job ${opts.job.id} dispatch crashed before completion: ${opts.message}`,
    sourceRefs: [],
  });
  opts.diagnostics.push(dispatchDiag);
  let summary: JobDrainSummary;
  if (retry) {
    markJobPending(
      opts.projection,
      opts.job.id,
      new Date(opts.now().getTime() + retryDelayMs(opts.job.attempts)),
    );
    summary = Object.freeze({
      jobId: opts.job.id,
      processorId: opts.job.processorId,
      status: "rescheduled" as const,
      runId: null,
    });
  } else {
    markJobFailed(opts.projection, opts.job.id, opts.now());
    summary = Object.freeze({
      jobId: opts.job.id,
      processorId: opts.job.processorId,
      status: "failed" as const,
      runId: null,
    });
  }

  await recordDiagnosticsViaSink({
    sinks: opts.sinks,
    diagnostics: [dispatchDiag],
    processorId: "engine.jobs",
    proposalId: null,
  });
  return summary;
}

function retryDelayMs(attemptsAfterRun: number): number {
  const delay = 1000 * 2 ** Math.max(0, attemptsAfterRun - 1);
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}
