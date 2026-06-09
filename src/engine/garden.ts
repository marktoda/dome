// engine/garden: the garden-phase orchestrator.
//
// Per [[wiki/specs/processors]] §"Garden phase" and the v1 engine
// completion plan (Phases 4a + 4a' in
// [[cohesive/brainstorms/2026-05-27-v1-engine-completion]]), the
// orchestrator runs **after** a successful adoption. It walks the
// garden-phase processors via the injected `GardenPhaseRunner`,
// routes each emitted effect, and (Phase 4a') spawns sub-Proposals
// for garden-emitted PatchEffects.
//
// Phase 4a (shipped): garden-phase processors fire against the
// post-adoption signal stream; non-Patch effects (Diagnostic, Fact,
// Question, Job, External) route through `applyEffect` with
// `phase: "garden"` ensuring uniform broker enforcement +
// capability-use ledgering.
//
// Phase 4a' (this commit): garden-emitted auto-mode PatchEffects
// spawn sub-Proposals. The orchestrator routes the patch through the shared
// garden patch router, applies the patch to the adopted tree via
// `applyPatchToCandidate` to produce a new commit head, constructs a
// Proposal with `source: { kind: "garden", processorId, runId }`,
// and routes it through the injected `adoptSubProposal` callback —
// which is wired by the compiler host to recurse into
// `adopt()` + `runGardenPhase()` with `cascadeDepth + 1`.
//
// Cascade-depth cap: default 10. When a garden run at the cap emits
// a PatchEffect, the orchestrator records a `garden.cascade-cap`
// DiagnosticEffect (severity warning) and skips the spawn. This
// mirrors the fixed-point divergence pattern from
// [[wiki/gotchas/processor-fixed-point-divergence]].
//
// Propose-mode patches: log+drop in v1.0; surfaced as diagnostics
// once the lint-review flow is fully wired (cross-references
// [[wiki/specs/effects]] §"PatchEffect" §"mode: propose").
//
// House-style notes (matches src/engine/adopt.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - `Object.freeze` chosen over `as const` so misbehaving callers fail
//     loudly at runtime rather than silently mutating outputs.
//   - Pure orchestrator — owns no I/O directly; every mutation flows
//     through the injected `sinks` per [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]].

import type {
  DiagnosticEffect,
  PatchEffect,
  QuestionEffect,
} from "../core/effect";
import { diagnosticEffect } from "../core/effect";
import type { AdoptionResult, Proposal } from "../core/proposal";
import type { CommitOid } from "../core/source-ref";
import { applyEffect, type ApplyEffectSinks } from "./apply-effect";
import { applyPatchToCandidate } from "./apply-patch";
import type { SignalEvent } from "./compile-range";
import { recordDiagnosticsViaSink } from "./diagnostics";
import { deriveExtensionId } from "../extensions/id-helpers";
import type { LedgerDb } from "../ledger/db";
import { routeGardenPatchForSubProposal } from "./garden-patch-router";
import { spawnGardenSubProposal } from "./garden-sub-proposals";
import { recordEffectCapabilityUse } from "./effect-capability-use";
import type { GardenPhaseRunner, GardenProcessorStart, RunId } from "./runner-contract";
import type { EngineVault } from "./vault-shape";

// ----- DEFAULT_MAX_CASCADE_DEPTH --------------------------------------------

/**
 * The default cap on garden → sub-Proposal recursion depth. A garden
 * processor that emits a PatchEffect spawns a sub-Proposal; if THAT
 * adoption's garden phase emits another PatchEffect, depth is 2; and
 * so on. The cap prevents unbounded recursion when garden processors
 * react to each other in cycles.
 *
 * The default of 10 is generous; legitimate cascades (entity created →
 * backlinks added → search-index updated) usually reach depth 2-3.
 * Hitting the cap surfaces a `garden.cascade-cap` DiagnosticEffect;
 * the cap can be raised per-call via `maxCascadeDepth`.
 *
 * Mirrors the philosophy of `DEFAULT_MAX_ITERATIONS` in adopt.ts —
 * generous default, explicit override, structural fence against
 * pathological cycles.
 */
export const DEFAULT_MAX_CASCADE_DEPTH = 10;

// ----- GardenPhaseResult ----------------------------------------------------

/**
 * The outcome of one `runGardenPhase` invocation. Carries the per-processor
 * run summary (id, effect counts, broker outcomes), the aggregated
 * broker-emitted diagnostics, and a count of sub-Proposals spawned.
 */
export type GardenPhaseResult = {
  readonly proposalId: string;
  readonly runs: ReadonlyArray<GardenRunSummary>;
  /**
   * Count of sub-Proposals spawned from garden-emitted PatchEffects
   * during this run. Each spawned sub-Proposal is itself routed
   * through `adopt()` (recursively); their results aren't surfaced
   * directly here — they land in the run ledger.
   */
  readonly subProposalCount: number;
  /**
   * Count of garden-phase patches that were broker-rejected
   * (capability deny) and therefore did NOT spawn sub-Proposals.
   * The corresponding deny diagnostic is in `diagnostics`.
   */
  readonly rejectedPatchCount: number;
  /**
   * Broker-emitted diagnostics aggregated across all garden effect-routing
   * calls (downgrade / deny / phase-mismatch) plus orchestrator-emitted
   * diagnostics like `garden.cascade-cap`. Processor-emitted
   * `DiagnosticEffect`s are NOT included here — those route to their sink
   * normally and are visible via `projection.db.diagnostics`.
   */
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
  /**
   * The cascade depth at which this orchestrator was invoked. Top-level
   * garden runs are depth 0; sub-Proposal adoptions' garden runs are
   * depth 1; their sub-Proposals' garden runs are depth 2; etc. Visible
   * for telemetry / debugging.
   */
  readonly cascadeDepth: number;
};

/**
 * Per-processor summary of one garden invocation.
 */
export type GardenRunSummary = {
  readonly runId: RunId;
  readonly processorId: string;
  readonly effectCount: number;
  /**
   * Count of PatchEffects this processor emitted that the broker
   * authorized for sub-Proposal spawn (neither denied nor downgraded).
   * This counts the **authorized intake**, not the actual spawned count
   * — patches authorized but skipped because the cap was hit or no
   * `adoptSubProposal` callback was wired are still counted here. The
   * aggregate `subProposalCount` field on `GardenPhaseResult` carries
   * the actual spawned count.
   */
  readonly authorizedPatchCount: number;
};

// ----- AdoptSubProposalFn ---------------------------------------------------

/**
 * The callback signature the orchestrator invokes to adopt a sub-Proposal
 * spawned from a garden-emitted PatchEffect.
 *
 * Wired by the caller (typically `compiler-host.ts`'s `runOneAdoption`)
 * to a recursive closure: the closure calls `adopt()` on the sub-Proposal,
 * then if adopted, calls `runGardenPhase()` again with `cascadeDepth + 1`
 * + the same closure. This is the structural recursion that lets garden
 * cascades unfold.
 *
 * The orchestrator does NOT inspect the returned `AdoptionResult` other
 * than to surface its successful-spawn count. Sub-Proposal failures (a
 * blocking diagnostic during the sub-adoption) land in the run ledger
 * and projection diagnostics like any other adoption block; they don't
 * propagate up to the parent garden run.
 */
export type AdoptSubProposalFn = (
  subProposal: Proposal,
  cascadeDepth: number,
) => Promise<AdoptionResult>;

// ----- runGardenPhase -------------------------------------------------------

/**
 * Run the garden phase against a just-adopted commit. The orchestrator:
 *
 *   1. Invokes the injected `GardenPhaseRunner`.
 *   2. For each runner result, walks the emitted effects:
 *      - Non-Patch effects route through `applyEffect({ phase: "garden", ... })`.
 *      - Auto-mode Patch effects pass through the shared garden patch router;
 *        accepted ones are queued for sub-Proposal
 *        spawn.
 *      - Propose-mode Patch effects log+drop (v1.0; full lint-review
 *        wiring is a separate phase).
 *   3. After the effects pass, processes the spawn queue: applies each
 *      queued patch to the adopted tree via `applyPatchToCandidate` to
 *      produce a new commit, constructs a garden-source Proposal, and
 *      calls `adoptSubProposal` (or emits cascade-cap diagnostic when
 *      `cascadeDepth >= maxCascadeDepth`).
 *
 * Garden does **not** have a fixed-point loop. Each garden processor
 * fires at most once per adoption.
 *
 * Garden-phase failures (a processor throwing, an effect being denied,
 * a sub-Proposal blocking) do NOT undo adoption. By the time this is
 * called, the adopted ref has already advanced.
 *
 * Returns the aggregated `GardenPhaseResult`. **Never throws** —
 * substrate-level failures (sink throws, applyPatchToCandidate throws,
 * sub-adoption throws) are caught and synthesized into a
 * `garden.crashed` DiagnosticEffect added to the result's `diagnostics`
 * array. Adoption has already completed by the time garden runs, so a
 * crash here doesn't roll back vault state. The crash diagnostic is returned
 * in-memory and the orchestrator attempts to persist it against the synthetic
 * `engine.garden` processor id through the injected sinks; host surfaces own
 * any stderr/log rendering.
 */
export async function runGardenPhase(opts: {
  readonly vault: EngineVault;
  readonly proposal: Proposal;
  readonly adopted: CommitOid;
  readonly changedPaths: ReadonlyArray<string>;
  readonly signals: ReadonlyArray<SignalEvent>;
  readonly runGardenProcessors: GardenPhaseRunner;
  readonly sinks: ApplyEffectSinks;
  readonly ledger?: LedgerDb;
  /**
   * Latest adopted ref inside a host tick. Top-level garden processors run
   * against `adopted`, but multiple spawned sub-Proposals must apply
   * sequentially to the latest adopted ref rather than all forking from the
   * same starting commit.
   */
  readonly currentAdopted?: () => CommitOid;
  readonly extensionIdFor?: (processorId: string) => string;
  /**
   * Optional sub-Proposal adoption callback. When absent, garden-emitted
   * PatchEffects log+drop (Phase 4a behavior). When present, they spawn
   * sub-Proposals routed through this callback (Phase 4a' behavior).
   *
   * Caller wiring: `compiler-host.ts` constructs this as a recursive
   * closure that calls `adopt()` + `runGardenPhase()` with
   * `cascadeDepth + 1`.
   */
  readonly adoptSubProposal?: AdoptSubProposalFn;
  /** Current cascade depth. Top-level call passes 0 (or omits). */
  readonly cascadeDepth?: number;
  /** Cap on cascade recursion. Defaults to `DEFAULT_MAX_CASCADE_DEPTH`. */
  readonly maxCascadeDepth?: number;
  readonly now?: () => Date;
  /**
   * Optional observability callback forwarded to the `GardenPhaseRunner`.
   * Fires immediately before each garden processor is dispatched so CLI
   * surfaces can print a live "▶ running <processorId>" line. Engine code
   * must not log; only CLI surfaces wire this callback.
   */
  readonly onProcessorStart?: (info: GardenProcessorStart) => void;
}): Promise<GardenPhaseResult> {
  const cascadeDepth = opts.cascadeDepth ?? 0;
  try {
    return await runGardenPhaseInner(opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const crashDiag = diagnosticEffect({
      severity: "error",
      code: "garden.crashed",
      message:
        `Garden orchestrator crashed during runGardenPhase at ` +
        `depth=${cascadeDepth}: ${msg}`,
      sourceRefs: [],
    });
    const diagnostics: DiagnosticEffect[] = [crashDiag];
    try {
      await recordDiagnosticsViaSink({
        sinks: opts.sinks,
        diagnostics: [crashDiag],
        processorId: "engine.garden",
        proposalId: opts.proposal.id,
      });
    } catch (recordError) {
      const recordMsg =
        recordError instanceof Error ? recordError.message : String(recordError);
      diagnostics.push(
        diagnosticEffect({
          severity: "error",
          code: "garden.crash-diagnostic-record-failed",
          message: `Garden crash diagnostic was not recorded: ${recordMsg}`,
          sourceRefs: [],
        }),
      );
    }
    return frozenResult({
      proposalId: opts.proposal.id,
      runs: [],
      subProposalCount: 0,
      rejectedPatchCount: 0,
      diagnostics,
      cascadeDepth,
    });
  }
}

/**
 * The orchestrator body, unwrapped from the try/catch. Splitting the
 * crash-handling from the happy path keeps the inner function focused
 * on the routing logic without throw-aware bookkeeping at every
 * await.
 */
async function runGardenPhaseInner(opts: {
  readonly vault: EngineVault;
  readonly proposal: Proposal;
  readonly adopted: CommitOid;
  readonly changedPaths: ReadonlyArray<string>;
  readonly signals: ReadonlyArray<SignalEvent>;
  readonly runGardenProcessors: GardenPhaseRunner;
  readonly sinks: ApplyEffectSinks;
  readonly ledger?: LedgerDb;
  readonly currentAdopted?: () => CommitOid;
  readonly extensionIdFor?: (processorId: string) => string;
  readonly adoptSubProposal?: AdoptSubProposalFn;
  readonly cascadeDepth?: number;
  readonly maxCascadeDepth?: number;
  readonly now?: () => Date;
  readonly onProcessorStart?: (info: GardenProcessorStart) => void;
}): Promise<GardenPhaseResult> {
  const {
    vault,
    proposal,
    adopted,
    changedPaths,
    signals,
    runGardenProcessors,
    sinks,
    ledger,
    currentAdopted,
    extensionIdFor = deriveExtensionId,
    adoptSubProposal,
  } = opts;
  const cascadeDepth = opts.cascadeDepth ?? 0;
  const maxCascadeDepth =
    opts.maxCascadeDepth ?? DEFAULT_MAX_CASCADE_DEPTH;

  const runnerResults = await runGardenProcessors({
    vault,
    adopted,
    changedPaths,
    signals,
    proposal,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.onProcessorStart !== undefined
      ? { onProcessorStart: opts.onProcessorStart }
      : {}),
  });

  if (runnerResults.length === 0) {
    return frozenResult({
      proposalId: proposal.id,
      runs: [],
      subProposalCount: 0,
      rejectedPatchCount: 0,
      diagnostics: [],
      cascadeDepth,
    });
  }

  const allDiagnostics: DiagnosticEffect[] = [];
  const runSummaries: GardenRunSummary[] = [];
  let totalSubProposals = 0;
  let totalRejectedPatches = 0;

  // Queue of patches authorized for sub-Proposal spawn, collected
  // across all runner results in this orchestrator invocation. Processed
  // after the per-effect loop completes (so all broker decisions are
  // recorded before any recursive adopt() fires).
  type SpawnRequest = {
    readonly patch: PatchEffect;
    readonly processorId: string;
    readonly runId: RunId;
  };
  const spawnQueue: SpawnRequest[] = [];
  // Per-processor count of patches queued for spawn (for the summary).
  const spawnCountByProcessor = new Map<string, number>();

  for (const result of runnerResults) {
    const emittedDiagnostics = result.effects.filter(
      (effect): effect is DiagnosticEffect => effect.kind === "diagnostic",
    );
    const diagnosticsForResolution: DiagnosticEffect[] = [
      ...emittedDiagnostics,
    ];

    if (
      result.executionStatus === "succeeded" &&
      sinks.resolveFacts !== undefined
    ) {
      await sinks.resolveFacts({
        processorId: result.processorId,
        runId: result.runId,
        inspectedPaths: result.inspectedPaths,
      });
    }

    for (const effect of result.effects) {
      if (effect.kind === "patch") {
        const routed = await routeGardenPatchForSubProposal({
          effect,
          processorId: result.processorId,
          runId: result.runId,
          proposalId: proposal.id,
          declared: result.declared,
          granted: result.granted,
          sinks,
        });
        recordEffectCapabilityUse({
          ledger,
          runId: result.runId,
          ...(routed.capabilityUse !== undefined
            ? { capabilityUse: routed.capabilityUse }
            : {}),
        });
        if (routed.kind === "dropped") {
          allDiagnostics.push(...routed.diagnostics);
          diagnosticsForResolution.push(...routed.diagnostics);
          if (routed.rejected) {
            totalRejectedPatches += 1;
          }
          continue;
        }
        if (routed.diagnostics.length > 0) {
          allDiagnostics.push(...routed.diagnostics);
          diagnosticsForResolution.push(...routed.diagnostics);
        }
        spawnQueue.push({
          patch: routed.patch,
          processorId: result.processorId,
          runId: result.runId,
        });
        spawnCountByProcessor.set(
          result.processorId,
          (spawnCountByProcessor.get(result.processorId) ?? 0) + 1,
        );
        continue;
      }

      // Non-Patch effect: route through applyEffect normally.
      const applied = await applyEffect({
        effect,
        processorId: result.processorId,
        runId: result.runId,
        proposalId: proposal.id,
        phase: "garden",
        declared: result.declared,
        granted: result.granted,
        sinks,
        candidate: adopted,
      });

      if (applied.diagnostics.length > 0) {
        allDiagnostics.push(...applied.diagnostics);
        diagnosticsForResolution.push(...applied.diagnostics);
      }

      recordEffectCapabilityUse({
        ledger,
        runId: result.runId,
        ...(applied.capabilityUse !== undefined
          ? { capabilityUse: applied.capabilityUse }
          : {}),
      });
    }

    if (
      result.executionStatus === "succeeded" &&
      sinks.resolveDiagnostics !== undefined
    ) {
      await sinks.resolveDiagnostics({
        processorId: result.processorId,
        runId: result.runId,
        inspectedPaths: result.inspectedPaths,
        emittedDiagnostics: diagnosticsForResolution,
      });
    }

    if (
      result.executionStatus === "succeeded" &&
      sinks.resolveQuestions !== undefined
    ) {
      await sinks.resolveQuestions({
        processorId: result.processorId,
        runId: result.runId,
        inspectedPaths: result.inspectedPaths,
        emittedQuestions: result.effects.filter(
          (effect): effect is QuestionEffect => effect.kind === "question",
        ),
      });
    }

    runSummaries.push(
      Object.freeze({
        runId: result.runId,
        processorId: result.processorId,
        effectCount: result.effects.length,
        authorizedPatchCount: spawnCountByProcessor.get(result.processorId) ?? 0,
      }),
    );
  }

  // Process the spawn queue.
  if (spawnQueue.length > 0) {
    if (adoptSubProposal === undefined) {
      // Caller didn't wire sub-Proposal spawn; log+drop the entire
      // queue with a v1.0-placeholder diagnostic so operators see the
      // dropped work. (Today this path fires when a caller invokes
      // runGardenPhase without wiring the cascade — e.g., tests.)
      const drop = diagnosticEffect({
        severity: "info",
        code: "garden.sub-proposal-spawn-disabled",
        message:
          `Garden orchestrator received ${spawnQueue.length} authorized ` +
          `PatchEffect(s) but no adoptSubProposal callback was wired; ` +
          `patches dropped. Wire adoptSubProposal in the caller to enable ` +
          `sub-Proposal spawning.`,
        sourceRefs: [],
      });
      allDiagnostics.push(drop);
      await sinks.recordDiagnostic({
        effect: drop,
        processorId: "engine.garden",
        runId: spawnQueue[0]!.runId,
        proposalId: proposal.id,
      });
    } else if (cascadeDepth >= maxCascadeDepth) {
      // Cascade-cap hit. Emit one diagnostic naming the depth and the
      // count of skipped patches; don't fire any sub-Proposals.
      const capDiag = diagnosticEffect({
        severity: "warning",
        code: "garden.cascade-cap",
        message:
          `Garden sub-Proposal cascade hit cap=${maxCascadeDepth} at ` +
          `depth=${cascadeDepth}; ${spawnQueue.length} PatchEffect(s) ` +
          `skipped. Garden processors named: ` +
          `${[...new Set(spawnQueue.map((s) => s.processorId))].join(", ")}.`,
        sourceRefs: [],
      });
      allDiagnostics.push(capDiag);
      // Also record the cap diagnostic via the sinks so it lands in
      // projection.db.diagnostics for operator visibility.
      await sinks.recordDiagnostic({
        effect: capDiag,
        processorId: "engine.garden",
        runId: spawnQueue[0]!.runId,
        proposalId: proposal.id,
      });
    } else {
      // Spawn sub-Proposals for each authorized patch through the shared
      // conversion boundary used by garden, scheduler, queued jobs, and
      // answer handlers.
      for (const req of spawnQueue) {
        const base = currentAdopted?.() ?? adopted;
        const spawned = await spawnGardenSubProposal({
          vault,
          base,
          sourceHead: base,
          patch: req.patch,
          processorId: req.processorId,
          runId: req.runId,
          extensionId: extensionIdFor(req.processorId),
          cascadeDepth: cascadeDepth + 1,
          ...(opts.now !== undefined ? { now: opts.now } : {}),
          applyPatch: applyPatchToCandidate,
          adoptSubProposal,
        });
        if (spawned.kind === "spawned") {
          totalSubProposals += 1;
        }
      }
    }
  }

  return frozenResult({
    proposalId: proposal.id,
    runs: runSummaries,
    subProposalCount: totalSubProposals,
    rejectedPatchCount: totalRejectedPatches,
    diagnostics: allDiagnostics,
    cascadeDepth,
  });
}

// ----- internals ------------------------------------------------------------

function frozenResult(result: {
  readonly proposalId: string;
  readonly runs: ReadonlyArray<GardenRunSummary>;
  readonly subProposalCount: number;
  readonly rejectedPatchCount: number;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
  readonly cascadeDepth: number;
}): GardenPhaseResult {
  return Object.freeze({
    proposalId: result.proposalId,
    runs: Object.freeze([...result.runs]),
    subProposalCount: result.subProposalCount,
    rejectedPatchCount: result.rejectedPatchCount,
    diagnostics: Object.freeze([...result.diagnostics]),
    cascadeDepth: result.cascadeDepth,
  });
}
