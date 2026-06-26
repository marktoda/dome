// engine/operational/scheduler: cron-driven processor dispatch.
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
// House-style notes (matches src/engine/garden/garden.ts, src/engine/core/adopt.ts):
//   - `type X = { ... }` aliases, every field `readonly`.
//   - Pure orchestrator — never mutates outside its sinks/ledger.
//   - Throw-free at the call site: substrate failures (sink throws) are
//     wrapped as diagnostics, while processor execution failures are returned
//     by the executor boundary as diagnostic effects. The orchestrator's
//     outer try/catch wraps any leaked throw as a `scheduler.crashed`
//     diagnostic so the operator surface is honest.

import { compareStrings } from "../../core/compare";
import {
  diagnosticEffect,
  type DiagnosticEffect,
} from "../../core/effect";
import { nextFire, parseCron, type ParsedCron } from "./cron";
import {
  dispatchGardenRun,
  type GardenRunDeps,
} from "../garden/garden-run";
import {
  getCursor,
  upsertCursor,
} from "../../projections/schedule-cursors";
import type { ProjectionDb } from "../../projections/db";
import type { ProcessorRegistry } from "../../processors/registry";
import { latestScheduleRunStartedAt } from "../../ledger/runs";
import type { Processor } from "../../core/processor";
import type { TriggerMatch } from "../../processors/triggers";
import { recordDiagnosticsViaSink } from "../core/diagnostics";

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
 * Phase 4c v1 dispatches garden-phase schedule triggers only. View-phase
 * work is command-driven because scheduled ViewEffects have no caller-owned
 * delivery surface in v1; periodic work that should write or queue durable
 * state belongs in garden.
 */
// The scheduler-specific extras on top of the shared garden-run plumbing.
// `now` is required here (cron cursor math); the bag carries it as optional.
type SchedulerOptions = GardenRunDeps & {
  readonly registry: ProcessorRegistry;
  readonly projection: ProjectionDb;
  readonly now: () => Date;
};

export async function runScheduler(opts: SchedulerOptions): Promise<SchedulerResult> {
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
    const diagnostics: DiagnosticEffect[] = [crashDiag];
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
      diagnostics.push(
        diagnosticEffect({
          severity: "error",
          code: "scheduler.crash-diagnostic-record-failed",
          message: `Scheduler crash diagnostic was not recorded: ${recordMsg}`,
          sourceRefs: [],
        }),
      );
    }
    return Object.freeze({
      fired: Object.freeze([]),
      skipped: Object.freeze([]),
      diagnostics: Object.freeze(diagnostics),
    });
  }
}

async function runSchedulerInner(opts: SchedulerOptions): Promise<SchedulerResult> {
  // The scheduler reads only these fields for its own eligibility + cursor
  // bookkeeping; the rest of the garden-run plumbing rides in `opts` and is
  // forwarded to dispatchGardenRun untouched (opts ⊇ GardenRunDeps).
  const { registry, projection, sinks, now, ledger, signal } = opts;

  const nowDate = now();
  const fired: ScheduledFireResult[] = [];
  const skipped: { processorId: string; reason: string }[] = [];
  const diagnostics: DiagnosticEffect[] = [];

  // Walk garden-phase processors with schedule triggers. Adoption/view
  // schedule triggers are rejected at bundle-load time per the phase ×
  // trigger matrix at [[wiki/matrices/processor-phase-x-trigger]].
  const candidates: {
    readonly processor: Processor<unknown>;
    readonly phase: "garden";
    readonly cron: string;
  }[] = [];
  for (const p of registry.byPhase("garden")) {
    for (const t of p.triggers) {
      if (t.kind === "schedule") {
        candidates.push({ processor: p, phase: "garden", cron: t.cron });
        break; // one entry per processor — multiple schedule triggers per
        // processor are unusual; if needed in v1.x, expand here.
      }
    }
  }

  // ----- Evaluation pass ------------------------------------------------
  // Decide which candidates are due BEFORE dispatching any of them, so the
  // dispatch pass can run in deterministic cron-time order. A wake-tick
  // burst (the laptop slept through several crons; missed intervals collapse
  // to one fire each) must dispatch simultaneously-due processors in the
  // order their crons came due — sources fetch (05:10) before index render
  // (05:15) before the brief (05:30) — not in registry (alphabetical-by-id)
  // order. Tiebreak for equal due times: processor id.
  const due: {
    readonly processor: Processor<unknown>;
    readonly phase: "garden";
    readonly cron: string;
    readonly previousLastFire: string | null;
    /** When this fire came due. Brand-new processors (no cursor, no ledger
     * history) became due "now" — they sort after every missed cron. */
    readonly dueAt: Date;
  }[] = [];

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
    //   1. No cursor row → recover lastFire from the durable run ledger
    //      (projection rebuilds wipe schedule_cursors; without the fallback
    //      every restart-with-rebuild re-fires nightly jobs — 2026-06-10
    //      re-charged consolidate 11×). Truly new (no ledger history) →
    //      fire immediately.
    //   2. Cron changed → preserve lastFire, update the stored cron +
    //      nextFire from now, and do not retroactively fire.
    //   3. Cursor exists, cron matches: compute nextFire(parsed, lastFireDate);
    //      fire if nextFire <= nowDate.
    if (cursor === null) {
      const ledgerLastFire =
        ledger === undefined
          ? null
          : latestScheduleRunStartedAt(ledger, processor.id);
      if (ledgerLastFire === null) {
        due.push({
          processor,
          phase,
          cron,
          previousLastFire: null,
          dueAt: nowDate,
        });
      } else {
        const nextFireDate = nextFire(parsed, new Date(ledgerLastFire));
        if (nextFireDate.getTime() <= nowDate.getTime()) {
          due.push({
            processor,
            phase,
            cron,
            previousLastFire: ledgerLastFire,
            dueAt: nextFireDate,
          });
        } else {
          // Re-seed the cursor so the next tick reads case 3 directly.
          upsertCursor(projection, {
            processorId: processor.id,
            cron,
            lastFire: ledgerLastFire,
            nextFire: nextFireDate.toISOString(),
          });
          skipped.push({ processorId: processor.id, reason: "not-due" });
        }
      }
    } else if (cursor.cron !== cron) {
      upsertCursor(projection, {
        processorId: processor.id,
        cron,
        lastFire: cursor.lastFire,
        nextFire: nextFire(parsed, nowDate).toISOString(),
      });
      skipped.push({ processorId: processor.id, reason: "cron-changed" });
    } else {
      const nextFireDate = nextFire(parsed, new Date(cursor.lastFire));
      if (nextFireDate.getTime() <= nowDate.getTime()) {
        due.push({
          processor,
          phase,
          cron,
          previousLastFire: cursor.lastFire,
          dueAt: nextFireDate,
        });
      } else {
        skipped.push({ processorId: processor.id, reason: "not-due" });
      }
    }
  }

  due.sort(
    (a, b) =>
      a.dueAt.getTime() - b.dueAt.getTime() ||
      compareStrings(a.processor.id, b.processor.id),
  );

  // ----- Dispatch pass --------------------------------------------------
  for (const { processor, phase, cron, previousLastFire } of due) {
    if (signal?.aborted === true) {
      skipped.push({ processorId: processor.id, reason: "cancelled" });
      break;
    }
    // parseCron succeeded in the evaluation pass; re-parse for the cursor
    // computation below (cheap, and keeps the due entry free of parser
    // state).
    const parsed = parseCron(cron);

    let success: boolean;
    try {
      // Synthesize a TriggerMatch list for the schedule trigger. Empty
      // matchedSignals because schedule fires have no signal stream.
      const matches: ReadonlyArray<TriggerMatch> = Object.freeze([
        Object.freeze({
          trigger: { kind: "schedule" as const, cron },
          matchedSignals: Object.freeze([]),
        }),
      ] as TriggerMatch[]);

      // dispatchGardenRun owns the snapshot + dispatch + route envelope.
      // Scheduled garden PatchEffects become garden sub-Proposals (matching
      // signal-triggered garden semantics) rather than mutating a candidate
      // through the generic applyPatch sink. Schedule fires are not tied to a
      // user-drift Proposal (proposal_id = NULL); the run pins `nowDate` so
      // its ledger startedAt matches the cursor math and envelope.firedAt.
      const { result } = await dispatchGardenRun(
        opts,
        {
          processor,
          phase,
          envelope: Object.freeze({
            kind: "schedule" as const,
            cron,
            firedAt: nowDate.toISOString(),
          }),
          matches,
          now: nowDate,
          disabledDiagnostic: {
            code: "scheduler.garden-sub-proposal-spawn-disabled",
            message:
              `Scheduled garden processor ${processor.id} emitted ` +
              `an authorized PatchEffect, but no adoptSubProposal ` +
              `callback was wired; patch dropped.`,
          },
        },
        diagnostics,
      );

      // Success means the executor accepted the invocation as a processor
      // success. Executor failures/timeouts/cancellations and not-invoked
      // policy skips are normal RunnerResults carrying an explicit runtime
      // status, so use that stable boundary instead of diagnostic codes.
      // Per-effect denials by the broker don't count as run failure — they're
      // reported via `applied.diagnostics`.
      success = result.executionStatus === "succeeded";
      if (result.executionStatus === "cancelled") {
        skipped.push({ processorId: processor.id, reason: "cancelled" });
        break;
      }
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
