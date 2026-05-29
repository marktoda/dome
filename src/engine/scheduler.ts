// engine/scheduler: cron-driven processor dispatch.
//
// Per [[wiki/specs/processors]] §"Triggers and signals" and Phase 4c in
// [[cohesive/brainstorms/2026-05-27-v1-engine-completion]], processors
// may declare `{ kind: "schedule", cron: <expr> }` triggers. The
// scheduler is the engine subsystem that decides when those triggers
// fire and dispatches them through the appropriate phase runner.
//
// Where this runs:
//   - Once per top-level adoption attempt (the harness's `tick()` /
//     CLI's `dome sync` / `dome serve`'s poll). NOT per sub-Proposal —
//     schedule semantics are "what's due since last fire," independent
//     of how many sub-Proposals an adoption cascade spawned.
//   - After the primary adoption + its garden phase complete (so the
//     scheduler sees the new adopted state when dispatching garden-
//     phase schedule processors).
//
// Per-processor state:
//   - `projection.db.schedule_cursors` holds the last_fire / next_fire
//     pair per processor (per [[wiki/specs/projection-store]] §"Tables —
//     `schedule_cursors`"). The scheduler reads cursors at the top of
//     each tick + upserts a new cursor after firing a processor.
//
// At-most-once-per-sync clamp (per [[wiki/gotchas/scheduled-hook-idempotency]]):
//   - When firing a processor, set `last_fire = now`, NOT the missed-
//     interval time. Missed intervals collapse: if 3 hours passed but
//     only one tick fired, only one fire (not three).
//
// Cron-changed handling:
//   - When a cursor's `cron` field differs from the processor's
//     currently-declared cron (e.g., bundle author bumped the schedule),
//     the cursor's lastFire is preserved but nextFire is recomputed
//     from the new expression. No retroactive fires.
//
// New-processor handling:
//   - A schedule-triggered processor with no cursor row fires on the
//     first tick (treated as "missed every previous interval, collapse
//     to one fire now"). The first cursor is written with `last_fire =
//     now`.
//
// Clock injection:
//   - The scheduler takes a `now: () => Date` callback. The CLI default
//     passes `() => new Date()`; the harness passes `h.clock.now`.
//     Bounded scope (no global mutable clock); deterministic tests.
//
// House-style notes (matches src/engine/garden.ts, src/engine/adopt.ts):
//   - `type X = { ... }` aliases, every field `readonly`.
//   - Pure orchestrator — never mutates outside its sinks/ledger.
//   - Throw-free at the call site: substrate failures (sink throws) are
//     wrapped as diagnostics, while processor execution failures are returned
//     by the executor boundary as diagnostic effects. The orchestrator's
//     outer try/catch wraps any leaked throw as a `scheduler.crashed`
//     diagnostic so the operator surface is honest.

import {
  diagnosticEffect,
  type DiagnosticEffect,
} from "../core/effect";
import type { AdoptionResult, Proposal } from "../core/proposal";
import type { CommitOid } from "../core/source-ref";
import { applyEffect, type ApplyEffectSinks } from "./apply-effect";
import {
  applyPatchToCandidate,
  type ApplyPatchInput,
} from "./apply-patch";
import { nextFire, parseCron, type ParsedCron } from "./cron";
import { dispatchGardenPatchEffect } from "./garden-patch-dispatch";
import type { EngineVault } from "./vault-shape";
import {
  getCursor,
  upsertCursor,
} from "../projections/schedule-cursors";
import type { ProjectionDb } from "../projections/db";
import type { ProcessorRegistry } from "../processors/registry";
import type { LedgerDb } from "../ledger/db";
import type {
  Capability,
  OperationalQueryView,
  Processor,
  TreeOid,
} from "../core/processor";
import {
  dispatchOneProcessor,
  makeSnapshot,
} from "../processors/runtime";
import type { ExecutionPolicyCap } from "../processors/execution-policy";
import type { ProcessorExecutionState } from "../processors/execution-state";
import type { ModelProvider } from "./model-invoke";
import type { TriggerMatch } from "../processors/triggers";
import { recordDiagnosticsViaSink } from "./diagnostics";
import { recordEffectCapabilityUse } from "./effect-capability-use";

type AdoptScheduledSubProposalFn = (
  proposal: Proposal,
  cascadeDepth: number,
) => Promise<AdoptionResult>;

// ----- ScheduledFireResult --------------------------------------------------

/**
 * Per-processor outcome of one scheduler dispatch. The aggregate
 * `runSchedulerResult` collects these for the caller's telemetry.
 */
export type ScheduledFireResult = {
  readonly processorId: string;
  readonly phase: "garden" | "view";
  readonly cron: string;
  /** ISO-8601 of the cursor's lastFire BEFORE this fire (null when new). */
  readonly previousLastFire: string | null;
  /** ISO-8601 of the cursor's new lastFire (= `now` per the clamp). */
  readonly newLastFire: string;
  /** ISO-8601 of the next computed fire-after for the new cursor. */
  readonly nextFireAfter: string;
  /** Did the processor's run() succeed? `null` when the run was skipped. */
  readonly success: boolean | null;
};

export type SchedulerResult = {
  readonly fired: ReadonlyArray<ScheduledFireResult>;
  readonly skipped: ReadonlyArray<{ readonly processorId: string; readonly reason: string }>;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
};

// ----- runScheduler ---------------------------------------------------------

/**
 * Walk every schedule-triggered processor in the registry; fire each
 * whose computed next-fire is <= `now`. Updates the cursor table per
 * fire.
 *
 * Returns the aggregated `SchedulerResult`; never throws. Substrate
 * failures synthesize a `scheduler.crashed` diagnostic.
 *
 * Phase 4c v1 dispatches via the injected `gardenRunner` /
 * `viewRunner`. Garden-phase scheduled fires don't currently emit
 * sub-Proposal-spawning patches in any shipped bundle, but the
 * orchestrator routes their non-Patch effects through `applyEffect`
 * with the right phase so any future garden-scheduled patch path
 * would route correctly (the sub-Proposal cascade lives one layer
 * up in `compiler-host.ts`).
 */
export async function runScheduler(opts: {
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly registry: ProcessorRegistry;
  readonly projection: ProjectionDb;
  readonly sinks: ApplyEffectSinks;
  readonly resolveTree: (commit: CommitOid) => Promise<TreeOid>;
  readonly now: () => Date;
  readonly ledger?: LedgerDb;
  readonly executionState?: ProcessorExecutionState;
  readonly executionCap?: ExecutionPolicyCap;
  readonly modelProvider?: ModelProvider;
  readonly operational?: OperationalQueryView;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly adoptSubProposal?: AdoptScheduledSubProposalFn;
  readonly currentAdopted?: () => CommitOid;
  readonly applyGardenPatchToCandidate?: (
    opts: ApplyPatchInput,
  ) => Promise<CommitOid | null>;
}): Promise<SchedulerResult> {
  try {
    return await runSchedulerInner(opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const crashDiag = diagnosticEffect({
      severity: "error",
      code: "scheduler.crashed",
      message: `Scheduler crashed during runScheduler: ${msg}`,
      sourceRefs: [],
    });
    console.warn(`dome: scheduler crashed: ${msg}`);
    try {
      await recordDiagnosticsViaSink({
        sinks: opts.sinks,
        diagnostics: [crashDiag],
        processorId: "engine.scheduler",
        proposalId: null,
      });
    } catch (recordError) {
      const recordMsg =
        recordError instanceof Error ? recordError.message : String(recordError);
      console.warn(
        `dome: scheduler crash diagnostic was not recorded: ${recordMsg}`,
      );
    }
    return Object.freeze({
      fired: Object.freeze([]),
      skipped: Object.freeze([]),
      diagnostics: Object.freeze([crashDiag]),
    });
  }
}

async function runSchedulerInner(opts: {
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly registry: ProcessorRegistry;
  readonly projection: ProjectionDb;
  readonly sinks: ApplyEffectSinks;
  readonly resolveTree: (commit: CommitOid) => Promise<TreeOid>;
  readonly now: () => Date;
  readonly ledger?: LedgerDb;
  readonly executionState?: ProcessorExecutionState;
  readonly executionCap?: ExecutionPolicyCap;
  readonly modelProvider?: ModelProvider;
  readonly operational?: OperationalQueryView;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly adoptSubProposal?: AdoptScheduledSubProposalFn;
  readonly currentAdopted?: () => CommitOid;
  readonly applyGardenPatchToCandidate?: (
    opts: ApplyPatchInput,
  ) => Promise<CommitOid | null>;
}): Promise<SchedulerResult> {
  const {
    vault,
    adopted,
    registry,
    projection,
    sinks,
    resolveTree,
    now,
    ledger,
    executionState,
    executionCap,
    modelProvider,
    operational,
    resolveGrants,
    extensionIdFor,
    adoptSubProposal,
    currentAdopted,
  } = opts;
  const applyGardenPatch =
    opts.applyGardenPatchToCandidate ?? applyPatchToCandidate;

  const nowDate = now();
  const fired: ScheduledFireResult[] = [];
  const skipped: { processorId: string; reason: string }[] = [];
  const diagnostics: DiagnosticEffect[] = [];

  // Walk garden + view phase processors; only those with a schedule
  // trigger are candidates. Adoption-phase processors with schedule
  // triggers are rejected at bundle-load time per the phase × trigger
  // matrix at [[wiki/matrices/processor-phase-x-trigger]].
  const candidates: { processor: Processor<unknown>; phase: "garden" | "view"; cron: string }[] = [];
  for (const phase of ["garden", "view"] as const) {
    for (const p of registry.byPhase(phase)) {
      for (const t of p.triggers) {
        if (t.kind === "schedule") {
          candidates.push({ processor: p, phase, cron: t.cron });
          break; // one entry per processor — multiple schedule triggers per
          // processor are unusual; if needed in v1.x, expand here.
        }
      }
    }
  }

  for (const { processor, phase, cron } of candidates) {
    let parsed: ParsedCron;
    try {
      parsed = parseCron(cron);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const cronDiag = diagnosticEffect({
        severity: "error",
        code: "scheduler.cron-parse-failed",
        message: `Processor ${processor.id} has invalid cron "${cron}": ${msg}`,
        sourceRefs: [],
      });
      diagnostics.push(cronDiag);
      await recordDiagnosticsViaSink({
        sinks,
        diagnostics: [cronDiag],
        processorId: "engine.scheduler",
        proposalId: null,
      });
      skipped.push({ processorId: processor.id, reason: "cron-parse-failed" });
      continue;
    }

    const cursor = getCursor(projection, processor.id);

    // Decide whether to fire. Three cases:
    //   1. No cursor row → fire immediately.
    //   2. Cron changed → preserve lastFire, update the stored cron +
    //      nextFire from now, and do not retroactively fire.
    //   3. Cursor exists, cron matches: compute nextFire(parsed, lastFireDate);
    //      fire if nextFire <= nowDate.
    let shouldFire: boolean;
    let previousLastFire: string | null;
    if (cursor === null) {
      shouldFire = true;
      previousLastFire = null;
    } else if (cursor.cron !== cron) {
      previousLastFire = cursor.lastFire;
      upsertCursor(projection, {
        processorId: processor.id,
        cron,
        lastFire: cursor.lastFire,
        nextFire: nextFire(parsed, nowDate).toISOString(),
      });
      skipped.push({ processorId: processor.id, reason: "cron-changed" });
      continue;
    } else {
      previousLastFire = cursor.lastFire;
      const lastFireDate = new Date(cursor.lastFire);
      const nextFireDate = nextFire(parsed, lastFireDate);
      shouldFire = nextFireDate.getTime() <= nowDate.getTime();
    }

    if (!shouldFire) {
      skipped.push({ processorId: processor.id, reason: "not-due" });
      continue;
    }

    let success: boolean;
    try {
      const inputAdopted = currentAdopted?.() ?? adopted;
      // Build the snapshot once per fire — same shape adoptionRunner /
      // gardenRunner construct, just resolved against the adopted commit
      // (schedule fires see the post-adoption snapshot).
      const snapshot = await makeSnapshot(vault.path, inputAdopted, resolveTree);

      // Synthesize a TriggerMatch list for the schedule trigger. Empty
      // matchedSignals because schedule fires have no signal stream.
      const matches: ReadonlyArray<TriggerMatch> = Object.freeze([
        Object.freeze({
          trigger: { kind: "schedule" as const, cron },
          matchedSignals: Object.freeze([]),
        }),
      ] as TriggerMatch[]);

      const result = await dispatchOneProcessor({
        processor,
        phase,
        envelope: Object.freeze({
          kind: "schedule" as const,
          cron,
          firedAt: nowDate.toISOString(),
        }),
        snapshot,
        changedPaths: Object.freeze([]),
        // Schedule fires are not tied to a user-drift Proposal. The run
        // ledger records proposal_id = NULL; inputCommit records the adopted
        // snapshot the schedule fired against.
        proposal: null,
        inputCommit: inputAdopted,
        matches,
        resolveGrants,
        extensionIdFor,
        ledger,
        ...(executionState !== undefined ? { executionState } : {}),
        ...(executionCap !== undefined ? { executionCap } : {}),
        ...(modelProvider !== undefined ? { modelProvider } : {}),
        ...(operational !== undefined ? { operational } : {}),
      });

      // Route each emitted effect through the phase-appropriate boundary.
      // Scheduled garden PatchEffects become garden sub-Proposals, matching
      // signal-triggered garden semantics instead of mutating a candidate
      // through the generic applyPatch sink.
      for (const effect of result.effects) {
        if (phase === "garden" && effect.kind === "patch") {
          await dispatchGardenPatchEffect({
            effect,
            vault,
            adopted: inputAdopted,
            ...(currentAdopted !== undefined ? { currentAdopted } : {}),
            processorId: result.processorId,
            runId: result.runId,
            proposalId: null,
            declared: result.declared,
            granted: result.granted,
            sinks,
            diagnostics,
            applyGardenPatch,
            extensionId: extensionIdFor(result.processorId),
            ...(ledger !== undefined ? { ledger } : {}),
            ...(adoptSubProposal !== undefined ? { adoptSubProposal } : {}),
            disabledDiagnostic: {
              code: "scheduler.garden-sub-proposal-spawn-disabled",
              message:
                `Scheduled garden processor ${result.processorId} emitted ` +
                `an authorized PatchEffect, but no adoptSubProposal ` +
                `callback was wired; patch dropped.`,
            },
          });
          continue;
        }

        const applied = await applyEffect({
          effect,
          processorId: result.processorId,
          runId: result.runId,
          proposalId: null,
          phase,
          declared: result.declared,
          granted: result.granted,
          sinks,
          candidate: inputAdopted,
        });
        if (applied.diagnostics.length > 0) {
          diagnostics.push(...applied.diagnostics);
        }
        recordEffectCapabilityUse({
          ledger,
          runId: result.runId,
          ...(applied.capabilityUse !== undefined
            ? { capabilityUse: applied.capabilityUse }
            : {}),
        });
      }

      // Success means the executor accepted the invocation as a processor
      // success. Executor failures/timeouts/cancellations and not-invoked
      // policy skips are normal RunnerResults carrying an explicit runtime
      // status, so use that stable boundary instead of diagnostic codes.
      // Per-effect denials by the broker don't count as run failure — they're
      // reported via `applied.diagnostics`.
      success = result.executionStatus === "succeeded";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const dispatchDiag = diagnosticEffect({
        severity: "error",
        code: "scheduler.dispatch-failed",
        message: `Scheduler dispatch of ${processor.id} crashed: ${msg}`,
        sourceRefs: [],
      });
      diagnostics.push(dispatchDiag);
      await recordDiagnosticsViaSink({
        sinks,
        diagnostics: [dispatchDiag],
        processorId: "engine.scheduler",
        proposalId: null,
      });
      success = false;
    }

    // Compute the new cursor.
    const newLastFire = nowDate.toISOString();
    const newNextFireDate = nextFire(parsed, nowDate);
    const newNextFire = newNextFireDate.toISOString();
    upsertCursor(projection, {
      processorId: processor.id,
      cron,
      lastFire: newLastFire,
      nextFire: newNextFire,
    });

    fired.push(
      Object.freeze({
        processorId: processor.id,
        phase,
        cron,
        previousLastFire,
        newLastFire,
        nextFireAfter: newNextFire,
        success,
      }),
    );
  }

  return Object.freeze({
    fired: Object.freeze(fired),
    skipped: Object.freeze(skipped),
    diagnostics: Object.freeze(diagnostics),
  });
}

// ----- ScheduleRunInput envelope --------------------------------------------
//
// What schedule-fired processors see as `ctx.input`. Differs from the
// garden/adoption envelopes (which carry `matchedTriggers`) — schedule
// fires have a single trigger + the fire timestamp.
export type ScheduleRunInput = {
  readonly kind: "schedule";
  readonly cron: string;
  readonly firedAt: string;
};
