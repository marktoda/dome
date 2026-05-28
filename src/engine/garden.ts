// engine/garden: the garden-phase orchestrator.
//
// Per [[wiki/specs/processors]] §"Garden phase" and the v1 engine
// completion plan (Phase 4a in
// [[cohesive/brainstorms/2026-05-27-v1-engine-completion]]), the
// orchestrator runs **after** a successful adoption. It walks the
// garden-phase processors via the injected `GardenPhaseRunner`,
// routes each emitted effect through `applyEffect` with
// `phase: "garden"`, and aggregates the outcome for the engine's
// caller.
//
// Phase 4a scope:
//   - Garden-phase processors fire against the post-adoption signal
//     stream computed from `base..adopted` (the same signals the
//     adoption loop saw via `compileRange`).
//   - Effects route through the same `applyEffect` chokepoint
//     adoption uses, ensuring uniform broker enforcement, capability-
//     use ledgering, and phase-compatibility checking.
//   - Garden-emitted PatchEffects (which should spawn **sub-Proposals**
//     per [[wiki/specs/proposals]] §"Garden-emitted Proposals") are
//     currently log+dropped by the wired `applyPatch` sink — see
//     §"Deferred to Phase 4a'" below.
//
// Phase 4a' (deferred follow-up, same end-to-end PR per the plan):
//   - Sub-Proposal spawn from garden-emitted PatchEffect: apply patch
//     to a candidate tree off the adopted ref, construct a Proposal
//     with `source: { kind: "garden", processorId, runId }`, route it
//     through `adopt()` recursively.
//   - Cascade-depth cap (default 10) with `garden.cascade-cap`
//     diagnostic on hit (mirrors the fixed-point divergence pattern).
//   - `drainProcessors()` semantics for in-flight cascade work.
//
// Until 4a' lands, garden-phase PatchEffects are visible in the run
// ledger (the processor's RunRecord captures the emitted effects'
// hashes via `markSucceeded`) but don't yet land patches into the
// vault. Bundles that emit garden-phase patches (`dome.intake`,
// `dome.links`) don't ship in this batch, so no real flow is blocked;
// the placeholder is documented in [[wiki/specs/processors]]
// §"Implementation status".
//
// House-style notes (matches src/engine/adopt.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - `Object.freeze` chosen over `as const` so misbehaving callers fail
//     loudly at runtime rather than silently mutating outputs.
//   - Pure orchestrator — owns no I/O directly; every mutation flows
//     through the injected `sinks` per [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]].

import type {
  DiagnosticEffect,
  Effect,
  PatchEffect,
} from "../core/effect";
import type { Proposal } from "../core/proposal";
import type { CommitOid } from "../core/source-ref";
import { applyEffect, type ApplyEffectSinks } from "./apply-effect";
import type { SignalEvent } from "./compile-range";
import { recordCapabilityUse } from "../ledger/capability-uses";
import type { LedgerDb } from "../ledger/db";
import type { GardenPhaseRunner, RunId } from "./runner-contract";
import type { EngineVault } from "./vault-shape";

// ----- GardenPhaseResult ----------------------------------------------------

/**
 * The outcome of one `runGardenPhase` invocation. Carries the per-processor
 * run summary (id, effect counts, broker outcomes), the aggregated
 * broker-emitted diagnostics, and a count of garden-phase PatchEffects that
 * were observed but deferred (until Phase 4a' wires sub-Proposal spawn).
 *
 * Returned to the caller (currently `adopt.ts`'s post-success hook) so the
 * caller can surface garden activity in event streams or telemetry without
 * itself touching the runner output.
 */
export type GardenPhaseResult = {
  readonly proposalId: string;
  readonly runs: ReadonlyArray<GardenRunSummary>;
  /**
   * Count of PatchEffects emitted by garden-phase processors. Today these
   * are observed but not applied (the wired `applyPatch` sink for garden
   * phase log+drops). Phase 4a' will route them through sub-Proposal
   * construction.
   */
  readonly deferredPatchCount: number;
  /**
   * Broker-emitted diagnostics aggregated across all garden effect-routing
   * calls (downgrade / deny / phase-mismatch). Processor-emitted
   * `DiagnosticEffect`s are NOT included here — those route to their sink
   * normally and are visible via `projection.db.diagnostics`.
   */
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
};

/**
 * Per-processor summary of one garden invocation. Mirrors what the engine
 * already surfaces for adoption-phase runs via `AdoptEvent`'s
 * `processor-result` shape — minus the iteration counter (garden runs
 * once, not in a loop).
 */
export type GardenRunSummary = {
  readonly runId: RunId;
  readonly processorId: string;
  readonly effectCount: number;
  /**
   * Count of PatchEffects this processor emitted that were deferred (see
   * `GardenPhaseResult.deferredPatchCount`). Sums across all processors
   * equal the aggregated `deferredPatchCount`.
   */
  readonly deferredPatchCount: number;
};

// ----- runGardenPhase -------------------------------------------------------

/**
 * Run the garden phase against a just-adopted commit. The orchestrator:
 *
 *   1. Invokes the injected `GardenPhaseRunner` (the processor-runtime
 *      callback from `src/processors/runtime.ts`'s `buildRuntime`).
 *   2. For each runner result, walks the emitted effects and routes them
 *      through `applyEffect({ phase: "garden", ... })`.
 *   3. Aggregates broker diagnostics, deferred-patch counts, and per-
 *      processor summaries.
 *
 * Garden does **not** have a fixed-point loop — every processor fires at
 * most once per adoption (no convergence semantics, no iteration cap).
 * Schedule + signal triggers may fire the same processor on subsequent
 * adoptions, but within a single adoption's garden phase each processor
 * fires zero-or-one time.
 *
 * Garden-phase failures (a processor throwing, an effect being denied) do
 * NOT undo adoption. The adopted ref has already advanced when this is
 * called; garden work is best-effort. Failures land in the run ledger
 * (`status: "failed"`) and are recoverable via `dome inspect runs`.
 *
 * Returns the aggregated `GardenPhaseResult`; never throws. Caller is
 * expected to thread the result into its own telemetry / event stream.
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
  } = opts;

  const runnerResults = await runGardenProcessors({
    vault,
    adopted,
    changedPaths,
    signals,
    proposal,
  });

  if (runnerResults.length === 0) {
    return frozenResult({
      proposalId: proposal.id,
      runs: [],
      deferredPatchCount: 0,
      diagnostics: [],
    });
  }

  const allDiagnostics: DiagnosticEffect[] = [];
  const runSummaries: GardenRunSummary[] = [];
  let totalDeferredPatches = 0;

  for (const result of runnerResults) {
    let deferredPatchesForRun = 0;

    for (const effect of result.effects) {
      // Garden-phase PatchEffect: deferred to Phase 4a'. We still route
      // it through applyEffect so the broker + ledger get a fair look at
      // the effect (capability check, phase-compatibility check), but
      // the wired `applyPatch` sink log+drops the patch. This means a
      // processor whose patch exceeds its grant still sees a deny
      // diagnostic; the only thing missing is the actual patch landing.
      if (effect.kind === "patch") {
        deferredPatchesForRun += 1;
        totalDeferredPatches += 1;
      }

      const applied = await applyEffect({
        effect,
        processorId: result.processorId,
        runId: result.runId,
        proposalId: proposal.id,
        phase: "garden",
        declared: result.declared,
        granted: result.granted,
        sinks,
        // For garden, `candidate` is the adopted commit — the snapshot
        // the processor read from. The `applyPatch` sink ignores this
        // for garden-phase patches in Phase 4a (log+drop placeholder);
        // it'll be the base for sub-Proposal construction in 4a'.
        candidate: adopted,
      });

      // Broker-emitted diagnostics (downgrade / deny / phase-mismatch)
      // accumulate. Processor-emitted DiagnosticEffects already route
      // to their sink via the applyEffect call above; not collected here.
      if (applied.diagnostics.length > 0) {
        allDiagnostics.push(...applied.diagnostics);
      }

      // Capability-use ledgering mirrors adopt.ts's loop. The structured
      // verdict surfaces on `applied.capabilityUse` for enforced effect
      // kinds (patch / fact / question / external). Pinned by
      // [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]] §"Structural
      // enforcement" §2.
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

    runSummaries.push(
      Object.freeze({
        runId: result.runId,
        processorId: result.processorId,
        effectCount: result.effects.length,
        deferredPatchCount: deferredPatchesForRun,
      }),
    );
  }

  return frozenResult({
    proposalId: proposal.id,
    runs: runSummaries,
    deferredPatchCount: totalDeferredPatches,
    diagnostics: allDiagnostics,
  });
}

// ----- internals ------------------------------------------------------------

/**
 * Build a frozen `GardenPhaseResult`. Mirrors the `frozenResult` helper in
 * `adopt.ts` — freezes both the outer result and the inner arrays so
 * downstream consumers cannot mutate the returned shape.
 */
function frozenResult(result: {
  readonly proposalId: string;
  readonly runs: ReadonlyArray<GardenRunSummary>;
  readonly deferredPatchCount: number;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
}): GardenPhaseResult {
  return Object.freeze({
    proposalId: result.proposalId,
    runs: Object.freeze([...result.runs]),
    deferredPatchCount: result.deferredPatchCount,
    diagnostics: Object.freeze([...result.diagnostics]),
  });
}

// Type marker to keep the unused-import linter quiet on `PatchEffect` —
// it's used by the §"Deferred to Phase 4a'" docs at top of file and will
// be the real type when sub-Proposal spawn lands. Removing this is a
// follow-up cleanup when 4a' lands.
type _PatchEffectIsUsedInDocs = PatchEffect;
type _EffectIsUsedInDocs = Effect;
