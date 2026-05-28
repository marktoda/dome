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
//   - Throw-free at the call site: substrate failures (sink throws,
//     processor throws) are absorbed via the existing runner exception
//     synthesis pattern. The orchestrator's outer try/catch wraps any
//     leaked throw as a `scheduler.crashed` diagnostic so the operator
//     surface is honest.

import { diagnosticEffect, type DiagnosticEffect } from "../core/effect";
import { type Proposal } from "../core/proposal";
import type { CommitOid, TreeOid } from "../core/source-ref";
import { applyEffect, type ApplyEffectSinks } from "./apply-effect";
import { nextFire, parseCron, type ParsedCron } from "./cron";
import type { EngineVault } from "./vault-shape";
import {
  getCursor,
  upsertCursor,
} from "../projections/schedule-cursors";
import type { ProjectionDb } from "../projections/db";
import type { ProcessorRegistry } from "../processors/registry";
import { recordCapabilityUse } from "../ledger/capability-uses";
import type { LedgerDb } from "../ledger/db";
import type { Capability, Processor } from "../core/processor";
import {
  dispatchOneProcessor,
  makeSnapshot,
} from "../processors/runtime";
import type { TriggerMatch } from "../processors/triggers";

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
 * up in `sync-shared.ts`).
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
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
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
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
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
    resolveGrants,
    extensionIdFor,
  } = opts;

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
      diagnostics.push(
        diagnosticEffect({
          severity: "error",
          code: "scheduler.cron-parse-failed",
          message: `Processor ${processor.id} has invalid cron "${cron}": ${msg}`,
          sourceRefs: [],
        }),
      );
      skipped.push({ processorId: processor.id, reason: "cron-parse-failed" });
      continue;
    }

    const cursor = getCursor(projection, processor.id);

    // Decide whether to fire. Three cases:
    //   1. No cursor row OR cron changed → fire immediately (the "first
    //      tick / cron-changed = fire" semantic per the file banner).
    //   2. Cursor exists, cron matches: compute nextFire(parsed, lastFireDate);
    //      fire if nextFire <= nowDate.
    //   3. Otherwise: skip.
    let shouldFire: boolean;
    let previousLastFire: string | null;
    if (cursor === null) {
      shouldFire = true;
      previousLastFire = null;
    } else if (cursor.cron !== cron) {
      shouldFire = true;
      previousLastFire = cursor.lastFire;
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

    // Dispatch. Use a synthetic Proposal for ledger linkage — schedule-
    // fired runs are not anchored to a specific user-drift Proposal,
    // but the runner machinery expects a Proposal-shaped envelope.
    // The synthetic id is namespaced `prop_sched_<unix-ms>_<rand>` so
    // it's distinguishable from `prop_<unix-ms>_<rand>` user-drift ids.
    const syntheticProposal: Proposal = Object.freeze({
      id: `prop_sched_${nowDate.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
      base: adopted,
      head: adopted,
      source: Object.freeze({
        kind: "garden",
        processorId: processor.id,
        runId: `sched_${nowDate.getTime()}`,
      }),
    });

    let success: boolean;
    try {
      // Build the snapshot once per fire — same shape adoptionRunner /
      // gardenRunner construct, just resolved against the adopted commit
      // (schedule fires see the post-adoption snapshot).
      const snapshot = await makeSnapshot(vault.path, adopted, resolveTree);

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
        // Schedule fires aren't tied to a user-drift Proposal but the
        // dispatcher's ledger lifecycle expects a Proposal-shaped
        // envelope. The synthetic Proposal (with both base+head = adopted
        // commit) gives the dispatcher what it needs for `runs.input_commit`
        // + the makeRunContext fallback path.
        proposal: syntheticProposal,
        inputCommit: adopted,
        matches,
        resolveGrants,
        extensionIdFor,
        ledger,
      });

      // Route each emitted effect through applyEffect with the right
      // phase. Same broker enforcement uniformity as garden / adoption.
      for (const effect of result.effects) {
        const applied = await applyEffect({
          effect,
          processorId: result.processorId,
          runId: result.runId,
          proposalId: syntheticProposal.id,
          phase,
          declared: result.declared,
          granted: result.granted,
          sinks,
          candidate: adopted,
        });
        if (applied.diagnostics.length > 0) {
          diagnostics.push(...applied.diagnostics);
        }
        if (ledger !== undefined && applied.capabilityUse !== undefined) {
          recordCapabilityUse(ledger, {
            runId: result.runId,
            capability: applied.capabilityUse.capability,
            resource: applied.capabilityUse.resource,
            outcome: applied.capabilityUse.outcome,
            recordedAt: new Date(),
          });
        }
      }

      // Success means the processor's run() returned without throwing.
      // Per-effect denials by the broker don't count as run failure —
      // they're reported via `applied.diagnostics`.
      success = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      diagnostics.push(
        diagnosticEffect({
          severity: "error",
          code: "scheduler.dispatch-failed",
          message: `Scheduler dispatch of ${processor.id} crashed: ${msg}`,
          sourceRefs: [],
        }),
      );
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
