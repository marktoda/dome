// adopt: the fixed-point adoption loop — the engine's entry point.
//
// Given a Proposal `(base, head)`, the loop iteratively runs adoption-phase
// processors against the candidate tree, routes each emitted Effect through
// the capability broker + applier sink, and either advances the adopted ref
// on convergence (a fixed point: an iteration with no auto-mode PatchEffects)
// or returns blocking diagnostics on divergence (any DiagnosticEffect with
// `severity: "block"`, or `MAX_ITER` hit).
//
// This file is the structural chokepoint behind:
//   - PROPOSALS_ARE_THE_ONLY_WRITE_PATH — the only entry into ref advance.
//   - EVERY_EFFECT_IS_CAPABILITY_CHECKED — every effect routes through
//     `applyEffect`, which calls `enforceCapability` exactly once.
//
// See docs/wiki/specs/adoption.md §"The fixed-point adoption loop" for the
// normative pseudocode this implements, and
// docs/wiki/gotchas/processor-fixed-point-divergence.md for the `MAX_ITER`
// cap behavior the loop enforces.
//
// v1 Phase 2 scope (intentional simplifications, documented per the phase
// plan):
//
//   - Processor runtime is injected. The actual registry walk + per-processor
//     invocation that produces effects is Phase 3 work; Phase 2 accepts an
//     `AdoptionPhaseRunner` callback at the boundary so the loop is testable
//     in isolation via a stub runner returning predetermined effects.
//   - Patch application is delegated to the sink. `applyPatch` (on
//     `ApplyEffectSinks`) is responsible for mutating the candidate tree;
//     Phase 4 wires the sink to actually apply patches via the working tree
//     + staging area. Phase 2 re-reads HEAD each iteration to detect
//     candidate progression — the sink updates the candidate out-of-band.
//   - Event emission is deferred. `engine.adoption.advanced` and
//     `engine.adoption.blocked` are NOT emitted from this layer; Phase 8
//     wires the ledger + event-emission surface. Phase 2 returns the
//     `AdoptionResult`; the caller is responsible for any event emission.
//   - Divergence diagnostics carry compact forensic detail. The loop keeps
//     the last 3 iteration summaries in memory and includes processor ids,
//     effect shapes, routed outcomes, and candidate movement in the cap-hit
//     blocking diagnostic. This avoids depending on a successfully flushed
//     ledger row for the exact failure path that may need debugging.
//
// House-style notes (matches src/engine/core/compile-range.ts,
// src/engine/core/capability-broker.ts, src/engine/core/apply-effect.ts,
// src/engine/core/closure-commit.ts):
//   - Banner cites the normative spec + the load-bearing invariants + the
//     MAX_ITER gotcha.
//   - `type X = { ... }` aliases, every field `readonly`.
//   - Optional fields use `field?: T` (not `T | undefined`) for
//     `exactOptionalPropertyTypes` cleanliness.
//   - Imports limited to sibling engine files (`./compile-range`,
//     `./capability-broker` indirectly via `./apply-effect`,
//     `./apply-effect`, `./closure-commit`, `./runner-contract` for the
//     outbound `AdoptionPhaseRunner` type), pure types from `../core/`,
//     the adopted-ref read/write chokepoint from `../adopted-ref`, the
//     git boundary from `../git`, the run-ledger handle + capability-use
//     accessor from `../ledger/` (required — every adoption run is
//     ledgered), and the `EngineVault` type from `./vault-shape`.
//     Note: `../run-context.makeRunContext` was previously imported to
//     mint per-effect run ids; the runtime now owns run-id allocation and
//     surfaces it on `RunnerResult.runId`, removing that dependency here.
//   - The applied-paths bookkeeping uses a `Set<string>` (insertion-order
//     iteration for the closure commit's touchedPaths argument is fine —
//     `makeClosureCommit` does not require sort order).

import type {
  Effect,
  DiagnosticEffect,
  PatchEffect,
} from "../../core/effect";
import { diagnosticEffect } from "../../core/effect";
import { effectsOfKind } from "../../core/effect-classify";
import type {
  AdoptionResult,
  Proposal,
} from "../../core/proposal";
import { commitOid, type CommitOid } from "../../core/source-ref";
import { setAdoptedRef, ZERO_SHA } from "../../adopted-ref";
import {
  clearFinalizeJournal,
  writeFinalizeJournal,
} from "./finalize-journal";
import {
  checkoutPathsAtRef,
  currentBranch,
  currentSha,
  isAncestor,
  writeRef,
} from "../../git";
// Note: `currentSha` was used Phase-2 to re-read HEAD after each iteration
// to detect candidate progression by an out-of-band sink mutation. Phase
// 12a removes that pattern — `applyPatch` returns the new candidate OID
// via `ApplyEffectResult.newCandidate`, which `adopt` threads forward
// directly. `currentSha` is still imported for the source-head snapshot
// taken once at loop start (`sourceHeadSha`).
import type { LedgerDb } from "../../ledger/db";
import { updateOutputCommit } from "../../ledger/runs";
import {
  applyEffect,
  type ApplyEffectResult,
  type ApplyEffectSinks,
} from "./apply-effect";
import { makeClosureCommit } from "./closure-commit";
import { compileRange } from "./compile-range";
import { recordDiagnosticsViaSink } from "./diagnostics";
import { recordEffectCapabilityUse } from "./effect-capability-use";
import type { AdoptionPhaseRunner, RunId } from "./runner-contract";
import type { EngineVault } from "./vault-shape";

// ----- AdoptEvent (verbose-mode observability) -----------------------------

/**
 * Per-step observability events the loop emits while it runs. Callers wire
 * an `onEvent` callback on `adopt(opts)` to receive them; the engine itself
 * never logs to stdout (separation of concerns — the CLI / daemon owns
 * formatting). Three event kinds, one per natural step boundary:
 *
 *   - `iteration-start`: the loop is about to invoke the runner. Surfaces
 *     the size of the work (changed paths, signals).
 *   - `processor-result`: a single processor's run completed (success
 *     or thrown — a throwing processor returns one synthesized
 *     diagnostic effect, surfaced here with `effectCount: 1`).
 *   - `iteration-end`: the loop finished one pass and is about to either
 *     converge (no auto-patches) or re-enter with a new candidate.
 *
 * The events are *advisory*. They do not affect adoption semantics; if
 * the callback throws, the loop still completes (the engine wraps the
 * callback in a try/catch so a misbehaving observer doesn't corrupt the
 * adoption pipeline).
 */
export type AdoptEvent =
  | {
      readonly kind: "iteration-start";
      readonly iteration: number;
      readonly changedPathCount: number;
      readonly signalCount: number;
    }
  | {
      readonly kind: "processor-result";
      readonly iteration: number;
      readonly processorId: string;
      readonly runId: RunId;
      readonly effectCount: number;
    }
  | {
      readonly kind: "iteration-end";
      readonly iteration: number;
      readonly autoPatchCount: number;
      readonly converged: boolean;
    };

/** Safely invoke an `onEvent` callback. Failures in the observer never
 *  corrupt the adoption loop — they're swallowed at the boundary. */
function emitEvent(
  onEvent: ((event: AdoptEvent) => void) | undefined,
  event: AdoptEvent,
): void {
  if (onEvent === undefined) return;
  try {
    onEvent(event);
  } catch {
    // Advisory event; never fail adoption because the observer threw.
  }
}

// ----- DEFAULT_MAX_ITERATIONS -----------------------------------------------

/**
 * The default cap on adoption-loop iterations per
 * docs/wiki/specs/adoption.md §"MAX_ITER and divergence". A legitimate
 * adoption converges in 1–3 iterations; legitimate fan-out across an
 * entity-rich vault may reach 10–20. The cap of 100 is generous; hitting
 * it surfaces a blocking `fixed-point.divergence` diagnostic (per
 * docs/wiki/gotchas/processor-fixed-point-divergence.md).
 *
 * Configurable per-call via `adopt`'s `maxIterations` option. Reducing
 * below 30 risks false positives on shipped-default processor sets.
 */
export const DEFAULT_MAX_ITERATIONS = 100;
const MAX_DIVERGENCE_HISTORY = 3;

type DivergenceProcessorHistory = {
  readonly processorId: string;
  readonly runId: RunId;
  readonly executionStatus: string;
  readonly emitted: ReadonlyArray<string>;
  readonly routed: ReadonlyArray<string>;
};

type DivergenceIterationHistory = {
  readonly iteration: number;
  readonly autoPatchCount: number;
  readonly processors: ReadonlyArray<DivergenceProcessorHistory>;
};

// ----- adopt ----------------------------------------------------------------

/**
 * Run the fixed-point adoption loop for a Proposal. Returns an
 * `AdoptionResult` describing whether the adopted ref advanced, the
 * diagnostics surfaced during the loop, the closure-commit OID (if any),
 * and the iteration count.
 *
 * Contract:
 *   - The adopted ref advances exactly once on `adopted: true`, at the end
 *     of the loop, via `setAdoptedRef`. Mid-loop crashes leave the ref
 *     unchanged.
 *   - Every emitted Effect passes through `applyEffect`, which calls
 *     `enforceCapability` exactly once. The loop never bypasses the broker.
 *   - On any `severity: "block"` diagnostic (broker-emitted or
 *     processor-emitted), the loop terminates with `adopted: false` and
 *     the adopted ref unchanged.
 *   - On `maxIterations` cap-hit without convergence, the loop terminates
 *     with `adopted: false` and appends a `fixed-point.divergence`
 *     blocking diagnostic.
 *
 * @param opts.vault                  The vault whose adopted ref this loop
 *                                    advances.
 * @param opts.proposal               The Proposal driving the loop.
 * @param opts.runAdoptionProcessors  Injected processor-runtime callback;
 *                                    Phase 3 wires the actual registry.
 * @param opts.sinks                  Effect-applier sinks; `noopSinks()`
 *                                    from `./apply-effect` is suitable for
 *                                    Phase 2 standalone validation.
 * @param opts.forceAdvance           When `true`, the adopted-ref write
 *                                    accepts a non-fast-forward advance.
 *                                    Internal/test recovery only in v1; the
 *                                    user-facing CLI refuses divergent
 *                                    history before Proposal construction.
 * @param opts.maxIterations          Per-call override of
 *                                    `DEFAULT_MAX_ITERATIONS`.
 */
export async function adopt(opts: {
  readonly vault: EngineVault;
  readonly proposal: Proposal;
  readonly runAdoptionProcessors: AdoptionPhaseRunner;
  readonly sinks: ApplyEffectSinks;
  readonly forceAdvance?: boolean;
  readonly maxIterations?: number;
  /**
   * Optional run-ledger handle. When present, the loop writes one
   * `capability_uses` row per `applyEffect` invocation that produced a
   * structured `capabilityUse` record (per
   * [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]] §"Structural
   * enforcement" §2). The run-ledger lifecycle itself (queued / running /
   * succeeded / failed) is owned by `src/processors/runtime.ts` — the
   * runtime allocates the run id and surfaces it on `RunnerResult.runId`,
   * which is what the engine uses to join the capability-use rows.
   *
   * Required: every adoption run is ledgered (the engine is never built
   * without a ledger), so this is the structural enforcer of
   * [[EVERY_PROCESSOR_RUN_IS_LEDGERED]].
   */
  readonly ledger: LedgerDb;
  /**
   * Optional observability callback. When provided, the loop emits
   * `AdoptEvent`s at iteration-start, processor-result, and iteration-end
   * boundaries. Used by `dome serve --verbose` / `dome sync --verbose` to
   * surface per-step progress to stdout. The engine itself never logs;
   * the callback owns formatting + output.
   */
  readonly onEvent?: (event: AdoptEvent) => void;
}): Promise<AdoptionResult> {
  const { vault, proposal, runAdoptionProcessors, sinks, ledger, onEvent } = opts;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const forceAdvance = opts.forceAdvance ?? false;
  const projectionBuffer = bufferAdoptionProjectionEffects(sinks);
  const routingSinks = projectionBuffer.sinks;

  // Snapshot the source HEAD once at loop start — it becomes the
  // `Dome-Source-Head` trailer on the closure commit and is invariant
  // across iterations (the loop only writes to candidate, not to HEAD's
  // user-history).
  const sourceHeadSha = await currentSha(vault.path);
  const sourceHead: CommitOid = commitOid(sourceHeadSha ?? ZERO_SHA);

  // The branch we'll advance the adopted ref on. `setAdoptedRef` requires a
  // branch name; a detached HEAD has none and cannot use the adopted-ref
  // substrate. Surface this as a failure with a non-block error diagnostic
  // (the loop never started) so callers see a structured result rather than
  // an unhandled exception.
  const branch = await currentBranch(vault.path);
  if (branch === null) {
    const detachedDiag = diagnosticEffect({
      severity: "block",
      code: "adoption.detached-head",
      message:
        "Cannot run adoption: HEAD is detached (no branch). The adopted-ref substrate requires a branch name to namespace under. Check out a branch and retry.",
      sourceRefs: [],
    });
    await recordDiagnosticsViaSink({
      sinks,
      diagnostics: [detachedDiag],
      processorId: "engine.adoption",
      proposalId: proposal.id,
    });
    return frozenResult({
      proposalId: proposal.id,
      adopted: false,
      adoptedRef: proposal.base,
      diagnostics: [detachedDiag],
      closureCommitOid: null,
      iterations: 0,
    });
  }

  // The candidate begins at the proposal head. Per the spec pseudocode the
  // base is `proposal.base` (the adopted ref at construction time); if the
  // user accumulated commits behind `adopted..head`, the range spans them.
  // No explicit `merge(adopted, head)` here — the proposal-construction
  // layer (the daemon) is responsible for surfacing a head that descends
  // from `adopted`. `adopt()` trusts the proposal contract.
  let candidate: CommitOid = proposal.head;
  const adopted: CommitOid = proposal.base;

  const allDiagnostics: DiagnosticEffect[] = [];
  const touchedPaths = new Set<string>();
  // Every run id surfaced by the runner across all iterations. The closure
  // commit's OID lands on each of these via `updateOutputCommit` after
  // `makeClosureCommit` returns — completing the dual-surface join from
  // `runs.output_commit` to the `Dome-Run` trailer.
  const contributingRunIds = new Set<RunId>();
  const divergenceHistory: DivergenceIterationHistory[] = [];

  // The loop body — bounded by maxIterations. Convergence is detected by
  // an iteration that produces no auto-mode PatchEffect; divergence is
  // detected by hitting the cap.
  let iteration = 0;
  for (iteration = 1; iteration <= maxIterations; iteration += 1) {
    const compiled = await compileRange({
      vaultPath: vault.path,
      base: adopted,
      head: candidate,
    });

    emitEvent(onEvent, {
      kind: "iteration-start",
      iteration,
      changedPathCount: compiled.changedPaths.length,
      signalCount: compiled.signals.length,
    });

    const runnerResults = await runAdoptionProcessors({
      vault,
      candidate,
      changedPaths: compiled.changedPaths,
      signals: compiled.signals,
      iteration,
      proposal,
    });

    // Per-iteration accumulators. `effectsThisIteration` carries the
    // *applied* effects (post-broker, post-downgrade) so the patch-detection
    // step sees the actual routed shape (an `auto → propose` downgrade does
    // NOT count as an auto-patch for fixed-point purposes).
    const effectsThisIteration: Effect[] = [];
    const processorHistories: DivergenceProcessorHistory[] = [];

    // Phase 12a: track the candidate OID across the per-effect loop. Each
    // successful PatchEffect's sink returns the new candidate via
    // `applied.newCandidate`; we thread it into the next effect's
    // applyEffect call so subsequent patches in the same iteration stack on
    // top of the latest candidate. After the for-each completes, the outer
    // `candidate` variable is updated to this iteration-end value so the
    // next iteration's compileRange + runner see the post-patch state.
    let candidateAtIterationEnd: CommitOid = candidate;

    for (const {
      runId,
      processorId,
      executionStatus,
      declared,
      granted,
      inspectedPaths,
      effects,
    } of runnerResults) {
      const emittedEffects = Object.freeze(effects.map(summarizeEffect));
      const routedEffects: string[] = [];

      // A run "contributes" to the closure commit iff at least one of its
      // effects is a PatchEffect — those are what land via `applyPatch`
      // and become part of the closure's content. Diagnostic-only runs
      // and the post-patch convergence iteration (which emits 0 effects)
      // don't contribute: their ledger row's `output_commit` stays NULL.
      //
      // Pre-H3 this set was populated unconditionally, so the closure
      // back-fill landed `output_commit` on every iteration's run —
      // including the convergence iter that didn't emit anything. That
      // produced N+1 contributing-marked rows for an N-iteration patch
      // loop, surfaced by `multiple-processors-same-commit.scenario` and
      // `patch-effect-applies.scenario` failing with "got 2".
      if (effects.some((e) => e.kind === "patch")) {
        contributingRunIds.add(runId);
      }
      emitEvent(onEvent, {
        kind: "processor-result",
        iteration,
        processorId,
        runId,
        effectCount: effects.length,
      });
      const emittedDiagnostics = effectsOfKind(effects, "diagnostic");
      const diagnosticsForResolution: DiagnosticEffect[] = [
        ...emittedDiagnostics,
      ];
      const emittedQuestions = effectsOfKind(effects, "question");
      if (
        executionStatus === "succeeded" &&
        routingSinks.resolveFacts !== undefined
      ) {
        await routingSinks.resolveFacts({
          processorId,
          runId,
          inspectedPaths,
        });
      }
      for (const effect of effects) {
        const applied = await applyEffect({
          effect,
          processorId,
          runId,
          proposalId: proposal.id,
          phase: "adoption",
          declared,
          granted,
          sinks: routingSinks,
          candidate: candidateAtIterationEnd,
        });
        routedEffects.push(summarizeRoutedEffect(effect, applied));

        // Ledger: capability-use rows per [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]
        // §"Structural enforcement" §2. The broker's structured verdict
        // surfaces on `applied.capabilityUse` (populated for enforced
        // effect kinds — patch / fact / question / external; undefined
        // for diagnostic / view / job and for `rejected-by-phase` outcomes
        // where the broker was never consulted). Written here, with the
        // runtime-allocated `runId` joining the row to the ledger's
        // `runs.id`.
        recordEffectCapabilityUse({
          ledger,
          runId,
          ...(applied.capabilityUse !== undefined
            ? { capabilityUse: applied.capabilityUse }
            : {}),
        });

        // Broker-emitted diagnostics: deny / downgrade-surprise / phase-
        // mismatch. These ride on `applied.diagnostics` regardless of
        // outcome and accumulate so the severity check below sees them.
        if (applied.diagnostics.length > 0) {
          allDiagnostics.push(...applied.diagnostics);
          diagnosticsForResolution.push(...applied.diagnostics);
        }

        if (applied.appliedEffect !== null) {
          effectsThisIteration.push(applied.appliedEffect);
          // Processor-emitted block-severity DiagnosticEffects also belong
          // in the severity accumulator. `applyEffect` records them via
          // `sinks.recordDiagnostic` and returns `outcome: "applied"`
          // with empty `applied.diagnostics`, so we collect them here
          // from `applied.appliedEffect`. Per adoption.md §"DiagnosticEffect",
          // any block-severity diagnostic in the adoption phase blocks the
          // loop — whether emitted by the broker or by a processor.
          if (applied.appliedEffect.kind === "diagnostic") {
            allDiagnostics.push(applied.appliedEffect);
          }
          if (applied.appliedEffect.kind === "patch") {
            for (const change of applied.appliedEffect.changes) {
              touchedPaths.add(change.path);
            }
          }
        }

        // Phase 12a: thread the new candidate OID forward when the sink
        // advanced it. `applied.newCandidate` is populated only for
        // successful PatchEffects whose sink returned a non-null OID
        // (the candidate-tree mutator path); other effects + placeholder
        // sinks leave it undefined and the candidate stays put.
        if (applied.newCandidate !== undefined) {
          candidateAtIterationEnd = applied.newCandidate;
        }
      }

      processorHistories.push(Object.freeze({
        processorId,
        runId,
        executionStatus,
        emitted: emittedEffects,
        routed: Object.freeze([...routedEffects]),
      }));

      if (
        executionStatus === "succeeded" &&
        routingSinks.resolveDiagnostics !== undefined
      ) {
        await routingSinks.resolveDiagnostics({
          processorId,
          runId,
          inspectedPaths,
          emittedDiagnostics: diagnosticsForResolution,
        });
      }
      if (
        executionStatus === "succeeded" &&
        routingSinks.resolveQuestions !== undefined
      ) {
        await routingSinks.resolveQuestions({
          processorId,
          runId,
          inspectedPaths,
          emittedQuestions,
        });
      }
    }

    // After the iteration's effects are routed, update the outer candidate
    // variable. The next iteration's compileRange + runner observe the new
    // candidate's tree; convergence is detected on the next iteration
    // (or this one, if no auto-patches landed). Replaces the Phase-2
    // pattern of re-reading HEAD via `currentSha` — the candidate OID
    // is now the engine's source of truth, not a side-effect on HEAD.
    candidate = candidateAtIterationEnd;

    // Severity check: any block-severity diagnostic — surfaced by the
    // broker (deny / phase-mismatch) or emitted by a processor directly —
    // terminates the loop immediately. The adopted ref is not advanced;
    // diagnostics are returned for the caller to surface.
    if (hasBlockingDiagnostic(allDiagnostics)) {
      return frozenResult({
        proposalId: proposal.id,
        adopted: false,
        adoptedRef: adopted,
        diagnostics: allDiagnostics,
        closureCommitOid: null,
        iterations: iteration,
      });
    }

    // Fixed-point detection: an iteration with no auto-mode PatchEffect
    // means processors observed the candidate tree and emitted no further
    // mutating work. The loop converges.
    const autoPatchesThisIteration = effectsThisIteration.filter(
      (e): e is PatchEffect => e.kind === "patch" && e.mode === "auto",
    );
    const converged = autoPatchesThisIteration.length === 0;
    pushDivergenceHistory(divergenceHistory, {
      iteration,
      autoPatchCount: autoPatchesThisIteration.length,
      processors: Object.freeze([...processorHistories]),
    });
    emitEvent(onEvent, {
      kind: "iteration-end",
      iteration,
      autoPatchCount: autoPatchesThisIteration.length,
      converged,
    });
    if (converged) {
      break;
    }
    // Otherwise: at least one auto-patch landed this iteration. The
    // candidate variable was advanced above via `applied.newCandidate`
    // for each successful sink call; the next iteration's compileRange +
    // runner read against the new tree. No HEAD re-read needed — Phase
    // 12a made `applyPatch`'s return the engine's single source of truth
    // for candidate-OID progression.
  }

  // Divergence check: if we exited the loop without breaking, we hit the
  // iteration cap. Append the blocking divergence diagnostic and return.
  // (The `break` above sets iteration to the converging iteration; if
  // we fell through the for-loop, iteration is `maxIterations + 1` because
  // the post-condition increments after the last successful execution.)
  if (iteration > maxIterations) {
    const divergenceDiag = diagnosticEffect({
      severity: "block",
      code: "fixed-point.divergence",
      message:
        `Adoption loop hit MAX_ITER=${maxIterations} without reaching fixed point. ` +
        "Recent iteration history: " +
        formatDivergenceHistory(divergenceHistory),
      sourceRefs: [],
    });
    allDiagnostics.push(divergenceDiag);
    await recordDiagnosticsViaSink({
      sinks,
      diagnostics: [divergenceDiag],
      processorId: "engine.adoption",
      proposalId: proposal.id,
    });
    return frozenResult({
      proposalId: proposal.id,
      adopted: false,
      adoptedRef: adopted,
      diagnostics: allDiagnostics,
      closureCommitOid: null,
      iterations: maxIterations,
    });
  }

  // Convergence reached. Close: in Phase 12a, the candidate-tree mutator
  // (`applyPatch`) lands each PatchEffect as its own plumbing commit
  // carrying the four `Dome-*` trailers, so the chain head (`candidate`)
  // *is* the closure. We surface `candidate` as the closure-commit OID
  // when it has moved from `proposal.head`; the run-ledger back-fill +
  // adopted-ref advance both target the chain head.
  //
  // The legacy `makeClosureCommit` path (stages `touchedPaths` from the
  // working tree, then `git commit`) only runs when no plumbing commits
  // landed — i.e., when the candidate stayed put. This covers the v0.5
  // legacy semantics where a processor mutated the working tree out-of-
  // band; the Phase 12a sink leaves the working tree alone, so this
  // branch is dormant under v1 first-party processors.
  const candidateAdvanced = candidate !== proposal.head;
  const closureCommitOid: CommitOid | null = candidateAdvanced
    ? candidate
    : await makeClosureCommit({
        vault,
        base: adopted,
        sourceHead,
        touchedPaths: [...touchedPaths],
        proposalId: proposal.id,
      });

  // Dual-surface join: when a closure commit landed AND a ledger is wired,
  // back-fill `runs.output_commit` on every contributing run. `markSucceeded`
  // wrote NULL there at processor-run-terminal time (the closure commit
  // didn't exist yet); this UPDATE lands the OID now that it does. The
  // two-write pattern is intentional — see
  // docs/wiki/gotchas/run-succeeded-before-closure.md.
  if (closureCommitOid !== null) {
    updateOutputCommit(ledger, {
      runIds: [...contributingRunIds],
      outputCommit: closureCommitOid,
    });
  }

  // Adopt: advance the adopted ref atomically. The new adopted commit is
  // the closure commit when one was made (the engine's accumulated patches
  // live there), or the proposal head's resolved candidate otherwise.
  const newAdopted: CommitOid = closureCommitOid ?? candidate;

  const outcome = await finalizeAdoption({
    vault,
    branch,
    sourceHead,
    newAdopted,
    forceAdvance,
    sinks,
    allDiagnostics,
    proposal,
    projectionBuffer,
  });

  if (outcome.kind === "blocked") {
    return frozenResult({
      proposalId: proposal.id,
      adopted: false,
      adoptedRef: adopted,
      diagnostics: allDiagnostics,
      closureCommitOid,
      iterations: iteration,
    });
  }

  return frozenResult({
    proposalId: proposal.id,
    adopted: true,
    adoptedRef: outcome.newAdopted,
    diagnostics: allDiagnostics,
    closureCommitOid,
    iterations: iteration,
  });
}

async function resolveRecoveredEngineAdoptionDiagnostics(
  sinks: ApplyEffectSinks,
): Promise<void> {
  await sinks.resolveDiagnostics?.({
    processorId: "engine.adoption",
    inspectedPaths: [],
    emittedDiagnostics: [],
  });
}

// ----- finalizeAdoption -----------------------------------------------------
//
// Adoption's own I/O shell: Phase 12c branch advance → materialization →
// adopted-ref advance → journal clear → projection flush. Called once per
// `adopt()` invocation after the fixed-point loop converges.
//
// The `abort()` helper inside collapses the repeated pattern:
//   push diagnostics → recordDiagnosticsViaSink → return blocked.
// Journal clearing (when needed) is done by the caller BEFORE invoking
// abort() so the helper stays uniform across all abort branches.
// Branches that have divergent journal-clear logic handle it explicitly
// before calling abort().

type FinalizeOutcome =
  | { readonly kind: "finalized"; readonly newAdopted: CommitOid }
  | { readonly kind: "blocked" };

async function finalizeAdoption(opts: {
  readonly vault: EngineVault;
  readonly branch: string;
  readonly sourceHead: CommitOid;
  readonly newAdopted: CommitOid;
  readonly forceAdvance: boolean;
  readonly sinks: ApplyEffectSinks;
  readonly allDiagnostics: DiagnosticEffect[];
  readonly proposal: Proposal;
  readonly projectionBuffer: { readonly flush: () => Promise<void> };
}): Promise<FinalizeOutcome> {
  const {
    vault,
    branch,
    sourceHead,
    newAdopted,
    forceAdvance,
    sinks,
    allDiagnostics,
    proposal,
    projectionBuffer,
  } = opts;

  // One abort() helper: push diagnostics, record via sink, return blocked.
  // Journal clearing is handled by each call site BEFORE invoking abort().
  async function abort(
    diagnostics: ReadonlyArray<DiagnosticEffect>,
  ): Promise<FinalizeOutcome> {
    allDiagnostics.push(...diagnostics);
    await recordDiagnosticsViaSink({
      sinks,
      diagnostics,
      processorId: "engine.adoption",
      proposalId: proposal.id,
    });
    return { kind: "blocked" };
  }

  // Phase 12c: when the successful adoption target is not already the source
  // branch's HEAD, advance `refs/heads/<branch>` to that target BEFORE
  // advancing the adopted ref. Per docs/v1.md §4.1 (local-eventual mode),
  // engine-produced commits live on the source branch's history — the
  // engine's commits are appended to `main` alongside the user's commits.
  //
  // Without this step, an engine-produced target commit would float as an
  // unreachable object on `main` (only `refs/dome/adopted/main` referenced
  // it). This includes both adoption closure commits and garden-sub-Proposal
  // heads that need no further adoption-phase normalization. Subsequent
  // adoption cycles would then re-construct identical-content commits as
  // siblings (not descendants) of the previous one. `setAdoptedRef`'s
  // fast-forward check would then refuse the advance:
  //
  //   "adopted ref refs/dome/adopted/<branch> (<prev-closure>) is not
  //    an ancestor of <new-closure>"
  //
  // forming a hard error loop on every poll. The fix is structural:
  // advance the branch so the closure commit is on its history.
  //
  // Working-tree impact: engine commits are created through git plumbing, so
  // after advancing the checked-out branch we materialize only the paths that
  // changed between the user's source head and the engine target. A dry-run
  // checkout happens before the branch move so uncommitted local edits block
  // adoption instead of being overwritten.
  //
  // Failure mode: if `writeRef` fails (disk full, permission denied), we
  // surface as a blocking diagnostic and do not advance the adopted ref
  // either. The next cycle will retry from a clean state since the engine
  // target commit is still a floating object the loop can reproduce.
  const branchAdvanceTarget = newAdopted;
  let materializePaths: ReadonlyArray<string> = Object.freeze([]);
  if (branchAdvanceTarget !== sourceHead) {
    // The branch advance must be a fast-forward of the head we are
    // replacing. The CAS below (`expectedOld: sourceHead`) only proves HEAD
    // has not moved since the loop-start snapshot — it does NOT prove the
    // candidate chain descends from that snapshot. A garden sub-Proposal's
    // candidate descends from the *adopted* commit; if a user commit landed
    // on the branch between adoption and the garden phase, `sourceHead`
    // contains that commit while the candidate does not, and advancing
    // would rewind the branch past the user's work (reachable only from the
    // reflog) and revert their content during materialization. Refuse with
    // a blocking diagnostic instead; the next tick re-derives the work on
    // top of the new head.
    const fastForward =
      sourceHead === ZERO_SHA ||
      (await isAncestor({
        path: vault.path,
        ancestor: sourceHead,
        descendant: branchAdvanceTarget,
      }));
    if (!fastForward) {
      // No journal written yet — no clearing needed before abort().
      return abort([
        diagnosticEffect({
          severity: "block",
          code: "adoption.branch-advance-not-fast-forward",
          message:
            `Refused to advance refs/heads/${branch} to engine target ` +
            `${branchAdvanceTarget.slice(0, 7)}: the target does not descend ` +
            `from the branch head ${sourceHead.slice(0, 7)} observed at loop ` +
            `start (a commit likely landed on the branch while this proposal ` +
            `was being adopted). No refs were moved; the work will be ` +
            `re-derived on the next sync.`,
          sourceRefs: [],
        }),
      ]);
    }
    materializePaths = await changedPathsBetween({
      vaultPath: vault.path,
      base: sourceHead,
      head: branchAdvanceTarget,
    });
    const materializeDiagnostic = await validateBranchMaterialization({
      vaultPath: vault.path,
      target: branchAdvanceTarget,
      paths: materializePaths,
    });
    if (materializeDiagnostic !== null) {
      // No journal written yet — no clearing needed before abort().
      return abort([materializeDiagnostic]);
    }

    try {
      // Persist the finalize intent BEFORE moving any ref. A crash between
      // the branch advance and the working-tree materialization is repaired
      // by `replayFinalizeJournal` on the next compiler-host tick; without
      // the journal the stale working tree would read as phantom user edits.
      await writeFinalizeJournal(vault.path, {
        branch,
        sourceHead,
        target: branchAdvanceTarget,
        paths: materializePaths,
        writtenAt: new Date().toISOString(),
      });
      await writeRef({
        path: vault.path,
        ref: `refs/heads/${branch}`,
        value: branchAdvanceTarget,
        expectedOld: sourceHead,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Journal may have been written; clear it before aborting.
      await clearFinalizeJournal(vault.path);
      return abort([
        diagnosticEffect({
          severity: "block",
          code: "adoption.branch-advance-failed",
          message: `Failed to advance refs/heads/${branch} to engine target ${branchAdvanceTarget.slice(0, 7)}: ${msg}`,
          sourceRefs: [],
        }),
      ]);
    }

    try {
      await materializeBranchTarget({
        vaultPath: vault.path,
        target: branchAdvanceTarget,
        paths: materializePaths,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const rollbackDiagnostic = await rollbackBranchAdvance({
        vaultPath: vault.path,
        branch,
        sourceHead,
        expectedOld: branchAdvanceTarget,
        paths: materializePaths,
      });
      // A completed rollback restored both the ref and the tree; the intent
      // is resolved. A failed rollback keeps the journal so the next tick's
      // replay can repair whatever state the crash/failure left behind.
      if (rollbackDiagnostic === null) await clearFinalizeJournal(vault.path);
      const materializeFailedDiag = diagnosticEffect({
        severity: "block",
        code: "adoption.working-tree-materialize-failed",
        message:
          `Advanced refs/heads/${branch} to engine target ` +
          `${branchAdvanceTarget.slice(0, 7)}, but failed to materialize ` +
          `the changed paths into the working tree: ${msg}` +
          rollbackMessage(rollbackDiagnostic, branch, sourceHead),
        sourceRefs: [],
      });
      // Journal already conditionally cleared above; call abort() with both
      // diags (rollbackDiagnostic may be null — filter it out).
      return abort([
        materializeFailedDiag,
        ...(rollbackDiagnostic !== null ? [rollbackDiagnostic] : []),
      ]);
    }
  }

  const writeResult = await setAdoptedRef(
    vault.path,
    branch,
    newAdopted,
    { forceAdvance },
  );
  if (!writeResult.ok) {
    // Ref-advance failed (typically `adopted-ref-divergence` per
    // ADOPTED_REF_IS_SEMANTIC_CURSOR). Surface as a blocking diagnostic;
    // the loop ran cleanly but the substrate refused the advance.
    const rollbackDiagnostic = branchAdvanceTarget !== sourceHead
      ? await rollbackBranchAdvance({
          vaultPath: vault.path,
          branch,
          sourceHead,
          expectedOld: branchAdvanceTarget,
          paths: materializePaths,
        })
      : null;
    if (rollbackDiagnostic === null) await clearFinalizeJournal(vault.path);
    const refAdvanceDiag = diagnosticEffect({
      severity: "block",
      code: "adoption.ref-advance-refused",
      message:
        `Failed to advance refs/dome/adopted/${branch}: ` +
        `${writeResult.error.kind === "validation" ? writeResult.error.message : writeResult.error.kind}` +
        rollbackMessage(rollbackDiagnostic, branch, sourceHead),
      sourceRefs: [],
    });
    // Journal already conditionally cleared above; call abort() with both
    // diags (rollbackDiagnostic may be null — filter it out).
    return abort([
      refAdvanceDiag,
      ...(rollbackDiagnostic !== null ? [rollbackDiagnostic] : []),
    ]);
  }

  // Finalization fully resolved: branch advanced (when needed), working
  // tree materialized, adopted ref advanced. The crash window is closed.
  if (branchAdvanceTarget !== sourceHead) {
    await clearFinalizeJournal(vault.path);
  }

  try {
    await resolveRecoveredEngineAdoptionDiagnostics(sinks);
    await projectionBuffer.flush();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    allDiagnostics.push(
      diagnosticEffect({
        severity: "warning",
        code: "adoption.projection-flush-failed",
        message:
          `Adoption advanced refs to ${newAdopted.slice(0, 7)}, but ` +
          `incremental projection flush failed: ${msg}. Projection rows are ` +
          `rebuildable and will be refreshed before adopted-state reads.`,
        sourceRefs: [],
      }),
    );
  }

  return { kind: "finalized", newAdopted };
}

// ----- internals ------------------------------------------------------------

async function changedPathsBetween(opts: {
  readonly vaultPath: string;
  readonly base: CommitOid;
  readonly head: CommitOid;
}): Promise<ReadonlyArray<string>> {
  const compiled = await compileRange({
    vaultPath: opts.vaultPath,
    base: opts.base,
    head: opts.head,
  });
  return compiled.changedPaths;
}

async function validateBranchMaterialization(opts: {
  readonly vaultPath: string;
  readonly target: CommitOid;
  readonly paths: ReadonlyArray<string>;
}): Promise<DiagnosticEffect | null> {
  try {
    await checkoutPathsAtRef({
      path: opts.vaultPath,
      ref: opts.target,
      filepaths: opts.paths,
      dryRun: true,
    });
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return diagnosticEffect({
      severity: "block",
      code: "adoption.working-tree-materialize-conflict",
      message:
        `Cannot materialize engine commit ${opts.target.slice(0, 7)} into ` +
        `the working tree without overwriting local edits: ${msg}`,
      sourceRefs: [],
    });
  }
}

async function materializeBranchTarget(opts: {
  readonly vaultPath: string;
  readonly target: CommitOid;
  readonly paths: ReadonlyArray<string>;
}): Promise<void> {
  await checkoutPathsAtRef({
    path: opts.vaultPath,
    ref: opts.target,
    filepaths: opts.paths,
  });
}

async function rollbackBranchAdvance(opts: {
  readonly vaultPath: string;
  readonly branch: string;
  readonly sourceHead: CommitOid;
  readonly expectedOld?: CommitOid;
  readonly paths: ReadonlyArray<string>;
}): Promise<DiagnosticEffect | null> {
  let refRolledBack = false;
  try {
    const writeOpts: Parameters<typeof writeRef>[0] = {
      path: opts.vaultPath,
      ref: `refs/heads/${opts.branch}`,
      value: opts.sourceHead,
    };
    if (opts.expectedOld !== undefined) writeOpts.expectedOld = opts.expectedOld;
    await writeRef(writeOpts);
    refRolledBack = true;
    await checkoutPathsAtRef({
      path: opts.vaultPath,
      ref: opts.sourceHead,
      filepaths: opts.paths,
    });
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (refRolledBack) {
      return diagnosticEffect({
        severity: "block",
        code: "adoption.branch-rollback-working-tree-conflict",
        message:
          `Rolled refs/heads/${opts.branch} back to source HEAD ` +
          `${opts.sourceHead.slice(0, 7)}, but refused to force-checkout ` +
          `affected working-tree paths because local edits may have arrived ` +
          `after adoption preflight: ${msg}. Reconcile the working tree ` +
          `manually, then rerun dome sync.`,
        sourceRefs: [],
      });
    }
    return diagnosticEffect({
      severity: "block",
      code: "adoption.branch-rollback-failed",
      message:
        `Failed to roll refs/heads/${opts.branch} ` +
        `back to source HEAD ${opts.sourceHead.slice(0, 7)} after adoption finalization failed: ${msg}`,
      sourceRefs: [],
    });
  }
}

function rollbackMessage(
  rollbackDiagnostic: DiagnosticEffect | null,
  branch: string,
  sourceHead: CommitOid,
): string {
  if (rollbackDiagnostic !== null) {
    if (rollbackDiagnostic.code === "adoption.branch-rollback-working-tree-conflict") {
      return (
        `; refs/heads/${branch} was rolled back to ${sourceHead.slice(0, 7)}, ` +
        "but affected working-tree paths were left untouched to preserve local edits."
      );
    }
    return "; rollback also failed, inspect diagnostics before continuing.";
  }
  return `; rolled refs/heads/${branch} and affected working-tree paths back to ${sourceHead.slice(0, 7)}.`;
}

function pushDivergenceHistory(
  history: DivergenceIterationHistory[],
  entry: DivergenceIterationHistory,
): void {
  history.push(Object.freeze({
    iteration: entry.iteration,
    autoPatchCount: entry.autoPatchCount,
    processors: Object.freeze([...entry.processors]),
  }));
  while (history.length > MAX_DIVERGENCE_HISTORY) {
    history.shift();
  }
}

function formatDivergenceHistory(
  history: ReadonlyArray<DivergenceIterationHistory>,
): string {
  if (history.length === 0) return "none captured.";
  const candidateProcessors = processorIdsWithPatches(history);
  return (
    history.map(formatDivergenceIteration).join(" | ") +
    `. Candidate processors: ${formatList(candidateProcessors, 8)}.`
  );
}

function formatDivergenceIteration(
  history: DivergenceIterationHistory,
): string {
  return (
    `iter ${history.iteration} autoPatches=${history.autoPatchCount}: ` +
    formatList(history.processors.map(formatDivergenceProcessor), 6)
  );
}

function formatDivergenceProcessor(
  history: DivergenceProcessorHistory,
): string {
  return (
    `${history.processorId}(${history.executionStatus}, run=${history.runId}) ` +
    `emitted=${formatList(history.emitted, 5)} ` +
    `routed=${formatList(history.routed, 5)}`
  );
}

function processorIdsWithPatches(
  history: ReadonlyArray<DivergenceIterationHistory>,
): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const iterationHistory of history) {
    for (const processor of iterationHistory.processors) {
      if (processor.emitted.some((summary) => summary.startsWith("patch:"))) {
        ids.add(processor.processorId);
      }
    }
  }
  return Object.freeze([...ids]);
}

function summarizeRoutedEffect(
  emitted: Effect,
  applied: ApplyEffectResult,
): string {
  const routed =
    applied.appliedEffect === null
      ? "none"
      : summarizeEffect(applied.appliedEffect);
  const candidate =
    applied.newCandidate === undefined
      ? ""
      : ` candidate=${shortOid(applied.newCandidate)}`;
  const diagnostics =
    applied.diagnostics.length === 0
      ? ""
      : ` diagnostics=${formatList(applied.diagnostics.map((d) => d.code), 4)}`;
  return (
    `${summarizeEffect(emitted)} -> ${applied.outcome} ` +
    `as ${routed}${candidate}${diagnostics}`
  );
}

function summarizeEffect(effect: Effect): string {
  switch (effect.kind) {
    case "patch": {
      const changes = effect.changes.map(
        (change) => `${change.kind}:${change.path}`,
      );
      return `patch:${effect.mode}[${formatList(changes, 4)}]`;
    }
    case "diagnostic":
      return `diagnostic:${effect.severity}:${effect.code}`;
    case "fact":
      return `fact:${effect.predicate}`;
    case "search-document":
      return `search-document:${effect.operation}:${effect.path}`;
    case "question":
      return `question:${effect.idempotencyKey}`;
    case "job":
      return `job:${effect.processorId}`;
    case "external":
      return `external:${effect.capability}`;
    case "outbox-recovery":
      return `outbox-recovery:${effect.action}:${effect.idempotencyKey}`;
    case "quarantine-recovery":
      return `quarantine-recovery:${effect.action}:${effect.processorId}`;
    case "run-recovery":
      return `run-recovery:${effect.action}:${effect.runId}`;
    case "view":
      return `view:${effect.name}`;
  }
}

function formatList(
  values: ReadonlyArray<string>,
  limit: number,
): string {
  if (values.length === 0) return "none";
  const head = values.slice(0, limit);
  const suffix = values.length > limit ? `,+${values.length - limit} more` : "";
  return head.join(",") + suffix;
}

function shortOid(oid: CommitOid): string {
  return oid.slice(0, 7);
}

type ResolveDiagnosticsInput = Parameters<
  NonNullable<ApplyEffectSinks["resolveDiagnostics"]>
>[0];
type ResolveFactsInput = Parameters<
  NonNullable<ApplyEffectSinks["resolveFacts"]>
>[0];
type ResolveQuestionsInput = Parameters<
  NonNullable<ApplyEffectSinks["resolveQuestions"]>
>[0];
type RecordFactInput = Parameters<ApplyEffectSinks["recordFact"]>[0];
type RecordSearchDocumentInput = Parameters<
  ApplyEffectSinks["recordSearchDocument"]
>[0];
type RecordQuestionInput = Parameters<ApplyEffectSinks["recordQuestion"]>[0];

type BufferedProjectionOperation =
  | {
      readonly kind: "resolveDiagnostics";
      readonly input: ResolveDiagnosticsInput;
    }
  | { readonly kind: "resolveFacts"; readonly input: ResolveFactsInput }
  | { readonly kind: "resolveQuestions"; readonly input: ResolveQuestionsInput }
  | { readonly kind: "recordFact"; readonly input: RecordFactInput }
  | {
      readonly kind: "recordSearchDocument";
      readonly input: RecordSearchDocumentInput;
    }
  | { readonly kind: "recordQuestion"; readonly input: RecordQuestionInput };

/**
 * Adoption runs processors against a candidate commit that might still block.
 * Diagnostics are recorded immediately so a blocked proposal remains
 * inspectable, but adopted-state projection rows (facts/search/questions and
 * stale-row resolution) are replayed only after the branch and adopted ref
 * have advanced. This keeps `projection.db` derived from the still-current
 * adopted commit when adoption fails.
 */
function bufferAdoptionProjectionEffects(sinks: ApplyEffectSinks): {
  readonly sinks: ApplyEffectSinks;
  readonly flush: () => Promise<void>;
} {
  const operations: BufferedProjectionOperation[] = [];
  const bufferedSinks: ApplyEffectSinks = {
    ...sinks,
    resolveDiagnostics: async (input) => {
      operations.push({ kind: "resolveDiagnostics", input });
    },
    resolveFacts: async (input) => {
      operations.push({ kind: "resolveFacts", input });
    },
    resolveQuestions: async (input) => {
      operations.push({ kind: "resolveQuestions", input });
    },
    recordFact: async (input) => {
      operations.push({ kind: "recordFact", input });
    },
    recordSearchDocument: async (input) => {
      operations.push({ kind: "recordSearchDocument", input });
    },
    recordQuestion: async (input) => {
      operations.push({ kind: "recordQuestion", input });
    },
  };

  return Object.freeze({
    sinks: Object.freeze(bufferedSinks),
    flush: async () => {
      for (const op of operations) {
        switch (op.kind) {
          case "resolveDiagnostics":
            await sinks.resolveDiagnostics?.(op.input);
            break;
          case "resolveFacts":
            await sinks.resolveFacts?.(op.input);
            break;
          case "resolveQuestions":
            await sinks.resolveQuestions?.(op.input);
            break;
          case "recordFact":
            await sinks.recordFact(op.input);
            break;
          case "recordSearchDocument":
            await sinks.recordSearchDocument(op.input);
            break;
          case "recordQuestion":
            await sinks.recordQuestion(op.input);
            break;
        }
      }
    },
  });
}

/**
 * Build a frozen AdoptionResult. `Object.freeze` on the inner diagnostics
 * array prevents downstream callers (or test mocks) from mutating the
 * returned shape; the outer result is frozen too. Mirrors the freeze policy
 * in `compile-range.ts` and `apply-effect.ts`.
 */
function frozenResult(result: {
  readonly proposalId: string;
  readonly adopted: boolean;
  readonly adoptedRef: CommitOid;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
  readonly closureCommitOid: CommitOid | null;
  readonly iterations: number;
}): AdoptionResult {
  return Object.freeze({
    proposalId: result.proposalId,
    adopted: result.adopted,
    adoptedRef: result.adoptedRef,
    diagnostics: Object.freeze([...result.diagnostics]),
    closureCommitOid: result.closureCommitOid,
    iterations: result.iterations,
  });
}

/**
 * True iff any diagnostic in the accumulator has `severity: "block"`. The
 * accumulator carries two diagnostic streams (the loop body merges both):
 *
 *   1. Router/broker diagnostics from `applied.diagnostics` — adoption
 *      PatchEffect denial and propose-mode review requirements are
 *      `severity: "block"`; downgrade-surprise remains `warning`;
 *      phase-mismatch remains `error`.
 *   2. Processor-emitted DiagnosticEffects pulled from
 *      `applied.appliedEffect` — these include block-severity adoption-
 *      blocking diagnostics (per adoption.md §"DiagnosticEffect"). The
 *      router records them via `sinks.recordDiagnostic` and returns
 *      `outcome: "applied"` with empty `applied.diagnostics`, so the loop
 *      additionally inspects the applied effect.
 *
 * Either stream's block-severity entry blocks the loop.
 */
function hasBlockingDiagnostic(
  diagnostics: ReadonlyArray<DiagnosticEffect>,
): boolean {
  for (const d of diagnostics) {
    if (d.severity === "block") return true;
  }
  return false;
}
