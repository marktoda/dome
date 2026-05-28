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
//   - Divergence diagnostic is minimal. The full forensic detail named in
//     `processor-fixed-point-divergence.md` (last 3 iterations' effect
//     histories, candidate-processor naming) is a Phase 3+ refinement when
//     the ledger is wired and per-iteration history is queryable. Phase 2
//     emits the blocking diagnostic with the iteration cap and a generic
//     message.
//
// House-style notes (matches src/engine/compile-range.ts,
// src/engine/capability-broker.ts, src/engine/apply-effect.ts,
// src/engine/closure-commit.ts):
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
//     accessor from `../ledger/` (Phase 6 — optional, threaded only when
//     the caller wires a ledger), and the `EngineVault` type from
//     `./vault-shape`.
//     Note: `../run-context.makeRunContext` was previously imported to
//     mint per-effect run ids; the runtime now owns run-id allocation and
//     surfaces it on `RunnerResult.runId`, removing that dependency here.
//   - The applied-paths bookkeeping uses a `Set<string>` (insertion-order
//     iteration for the closure commit's touchedPaths argument is fine —
//     `makeClosureCommit` does not require sort order).

import type { Effect, DiagnosticEffect, PatchEffect } from "../core/effect";
import { diagnosticEffect } from "../core/effect";
import type {
  AdoptionResult,
  Proposal,
} from "../core/proposal";
import { commitOid, type CommitOid } from "../core/source-ref";
import { setAdoptedRef, ZERO_SHA } from "../adopted-ref";
import { currentBranch, currentSha } from "../git";
import type { LedgerDb } from "../ledger/db";
import { recordCapabilityUse } from "../ledger/capability-uses";
import { updateOutputCommit } from "../ledger/runs";
import { applyEffect, type ApplyEffectSinks } from "./apply-effect";
import { makeClosureCommit } from "./closure-commit";
import { compileRange } from "./compile-range";
import { parsePatchPaths } from "./patch-parse";
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
 *                                    Surfaced through `dome sync
 *                                    --force-advance` per
 *                                    `adopted-ref-divergence.md`.
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
   * Optional during the Phase 6 transition: callers that pass a runtime
   * without a ledger pass no ledger here either, and the loop runs as in
   * Phase 5 (no ledger writes). Phase 7+ wires both end-to-end.
   */
  readonly ledger?: LedgerDb;
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
    return frozenResult({
      proposalId: proposal.id,
      adopted: false,
      adoptedRef: proposal.base,
      diagnostics: [
        diagnosticEffect({
          severity: "block",
          code: "adoption.detached-head",
          message:
            "Cannot run adoption: HEAD is detached (no branch). The adopted-ref substrate requires a branch name to namespace under. Check out a branch and retry.",
          sourceRefs: [],
        }),
      ],
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

    for (const { runId, processorId, declared, granted, effects } of runnerResults) {
      contributingRunIds.add(runId);
      emitEvent(onEvent, {
        kind: "processor-result",
        iteration,
        processorId,
        runId,
        effectCount: effects.length,
      });
      for (const effect of effects) {
        const applied = await applyEffect({
          effect,
          processorId,
          runId,
          proposalId: proposal.id,
          phase: "adoption",
          declared,
          granted,
          sinks,
        });

        // Ledger: capability-use rows per [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]
        // §"Structural enforcement" §2. The broker's structured verdict
        // surfaces on `applied.capabilityUse` (populated for enforced
        // effect kinds — patch / fact / question / external; undefined
        // for diagnostic / view / job and for `rejected-by-phase` outcomes
        // where the broker was never consulted). Written here, with the
        // runtime-allocated `runId` joining the row to the ledger's
        // `runs.id`.
        if (ledger !== undefined && applied.capabilityUse !== undefined) {
          recordCapabilityUse(ledger, {
            runId,
            capability: applied.capabilityUse.capability,
            resource: applied.capabilityUse.resource,
            outcome: applied.capabilityUse.outcome,
            recordedAt: new Date(),
          });
        }

        // Broker-emitted diagnostics: deny / downgrade-surprise / phase-
        // mismatch. These ride on `applied.diagnostics` regardless of
        // outcome and accumulate so the severity check below sees them.
        if (applied.diagnostics.length > 0) {
          allDiagnostics.push(...applied.diagnostics);
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
            for (const path of parsePatchPaths(applied.appliedEffect.patch)) {
              touchedPaths.add(path);
            }
          }
        }
      }
    }

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
    emitEvent(onEvent, {
      kind: "iteration-end",
      iteration,
      autoPatchCount: autoPatchesThisIteration.length,
      converged,
    });
    if (converged) {
      break;
    }

    // Otherwise: a patch landed via `sinks.applyPatch`. The sink is
    // responsible for mutating the candidate tree (Phase 4 wires the
    // working-tree writer). We re-read HEAD to pick up the new candidate
    // SHA; if HEAD didn't move (because the sink is a noop, as in
    // Phase 2 standalone validation), the candidate stays at the same
    // commit and the next iteration will see no new auto-patches and
    // converge naturally.
    const nextCandidate = await currentSha(vault.path);
    if (nextCandidate !== null) candidate = commitOid(nextCandidate);
  }

  // Divergence check: if we exited the loop without breaking, we hit the
  // iteration cap. Append the blocking divergence diagnostic and return.
  // (The `break` above sets iteration to the converging iteration; if
  // we fell through the for-loop, iteration is `maxIterations + 1` because
  // the post-condition increments after the last successful execution.)
  if (iteration > maxIterations) {
    allDiagnostics.push(
      diagnosticEffect({
        severity: "block",
        code: "fixed-point.divergence",
        message: `Adoption loop hit MAX_ITER=${maxIterations} without reaching fixed point. The last iteration's processors emitted patches that didn't converge.`,
        sourceRefs: [],
      }),
    );
    return frozenResult({
      proposalId: proposal.id,
      adopted: false,
      adoptedRef: adopted,
      diagnostics: allDiagnostics,
      closureCommitOid: null,
      iterations: maxIterations,
    });
  }

  // Convergence reached. Close: if engine-driven patches landed during the
  // loop, create the closure commit carrying the four Dome-* trailers.
  // `makeClosureCommit` returns null when `touchedPaths` is empty (the
  // loop reached fixed point on iteration 1 with no engine writes) or
  // when `vault.config.git.auto_commit_workflows` is false.
  const closureCommitOid = await makeClosureCommit({
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
  if (closureCommitOid !== null && ledger !== undefined) {
    updateOutputCommit(ledger, {
      runIds: [...contributingRunIds],
      outputCommit: closureCommitOid,
    });
  }

  // Adopt: advance the adopted ref atomically. The new adopted commit is
  // the closure commit when one was made (the engine's accumulated patches
  // live there), or the proposal head's resolved candidate otherwise.
  const newAdopted: CommitOid = closureCommitOid ?? candidate;
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
    allDiagnostics.push(
      diagnosticEffect({
        severity: "block",
        code: "adoption.ref-advance-refused",
        message: `Failed to advance refs/dome/adopted/${branch}: ${writeResult.error.kind === "validation" ? writeResult.error.message : writeResult.error.kind}`,
        sourceRefs: [],
      }),
    );
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
    adoptedRef: newAdopted,
    diagnostics: allDiagnostics,
    closureCommitOid,
    iterations: iteration,
  });
}

// ----- internals ------------------------------------------------------------

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
 *   1. Broker-emitted diagnostics from `applied.diagnostics` — deny
 *      (`severity: "error"`), downgrade-surprise (`severity: "warning"`),
 *      phase-mismatch (`severity: "error"`). Only the deny path's diagnostic
 *      would carry block severity in practice; the broker does not emit
 *      block-severity diagnostics in v1.
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

