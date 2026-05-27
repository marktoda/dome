// ProcessorRuntime: the adapter that satisfies the engine's
// `AdoptionPhaseRunner` callback contract by walking the loaded
// `ProcessorRegistry`, matching each adoption-phase processor's triggers
// against the per-iteration signals, packaging a `ProcessorContext` via
// `makeProcessorContext`, invoking `processor.run`, and collecting one
// `RunnerResult` per firing processor.
//
// See docs/wiki/specs/processors.md §"The three phases" + §"Triggers and
// signals" + §"Run ledger" for the operational contract this runtime
// implements, and docs/wiki/specs/adoption.md §"The fixed-point adoption
// loop" for the call site (`src/engine/adopt.ts`'s `runAdoptionProcessors`
// injection point).
//
// v1 Phase 3 scope (intentional simplifications, documented per the phase
// plan):
//
//   - Only the adoption-phase runner is exposed. Garden + view runners are
//     Phase 4+ work; the `ProcessorRuntime` type carries the slot so adding
//     them is additive, not a rename.
//   - The processor input is a uniform envelope: every adoption-phase
//     processor sees `ctx.input = { kind: "adoption", matchedTriggers }`
//     listing which of its declared triggers fired and which signal events
//     matched each. Per-processor `TInput` specialization is a Phase 4+
//     refinement.
//   - Tree-OID resolution is injected at `buildRuntime` time via the
//     `resolveTree` callback. Keeping this file pure of git imports lets
//     the consumer (`src/vault.ts` or a future `src/processors/index.ts`)
//     wire the resolver against the live git boundary while this runtime
//     stays I/O-free at the type layer.
//   - `model.invoke` is never wired on adoption-phase contexts (per
//     processors.md §"Adoption phase — bounded, deterministic,
//     merge-blocking" — adoption-phase processors never receive a model
//     handle). The factory's `modelInvoke` slot is left unset.
//   - Processor exceptions are caught per-processor and synthesized into a
//     `DiagnosticEffect` with `code: "processor-threw"`; the loop does not
//     crash. The synthesized diagnostic's severity is `error` (non-blocking)
//     so a single misbehaving processor does not refuse adoption — the
//     run-ledger surface and operator telemetry are the recovery path.
//
// House-style notes (matches src/processors/registry.ts,
// src/processors/triggers.ts, src/processors/context.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Optional fields use `field?: T` (not `T | undefined`) for
//     `exactOptionalPropertyTypes` cleanliness.
//   - `Object.freeze` chosen over `as const` so misbehaving callers fail
//     loudly at runtime rather than silently mutating runner outputs.
//   - Imports limited to: `../core/effect` (Effect + DiagnosticEffect +
//     `diagnosticEffect` helper), `../core/processor` (Processor +
//     Capability + Snapshot + TreeOid types), `../core/source-ref`
//     (CommitOid), `../engine/runner-contract` (AdoptionPhaseRunner +
//     RunnerResult — the neutral home for the engine's outbound runner
//     contract that this runtime implements), `./registry`
//     (ProcessorRegistry), `./triggers` (matchTriggers + TriggerMatch),
//     `./context` (makeProcessorContext + ProcessorContextInput),
//     `../run-context` (makeRunContext). No filesystem, git, or sqlite
//     imports — the `resolveTree` injection point is what bridges to git.

import type { DiagnosticEffect, Effect } from "../core/effect";
import { diagnosticEffect } from "../core/effect";
import type {
  Capability,
  ProcessorContext,
  Snapshot,
  TreeOid,
} from "../core/processor";
import type { CommitOid } from "../core/source-ref";
import type {
  AdoptionPhaseRunner,
  RunnerResult,
} from "../engine/runner-contract";
import type { ProcessorRegistry } from "./registry";
import { matchTriggers, type TriggerMatch } from "./triggers";
import {
  makeProcessorContext,
  type ProcessorContextInput,
} from "./context";
import { makeRunContext } from "../run-context";

// ----- AdoptionRunInput -----------------------------------------------------

/**
 * The uniform envelope every adoption-phase processor sees as `ctx.input`
 * during a Phase 3 runtime dispatch. `matchedTriggers` lists the (non-empty)
 * subset of the processor's declared triggers that fired, each annotated
 * with the SignalEvents that caused the match.
 *
 * Per-processor `TInput` specialization (e.g., a dome.index processor seeing
 * an index-update payload rather than a raw `TriggerMatch[]`) is a Phase 4+
 * refinement. For v1, the envelope is uniform across all adoption-phase
 * processors — the processor is responsible for inspecting
 * `ctx.input.matchedTriggers` if it cares which trigger fired.
 */
export type AdoptionRunInput = {
  readonly kind: "adoption";
  readonly matchedTriggers: ReadonlyArray<TriggerMatch>;
};

// ----- ProcessorRuntime -----------------------------------------------------

/**
 * The handle returned by `buildRuntime`. Carries the per-phase runner
 * callbacks the engine's adoption / garden / view entry points consume.
 *
 * v1 ships only `adoptionRunner`. The garden + view runners are Phase 4+
 * work; the type slot exists so adding them is additive, not a rename.
 */
export type ProcessorRuntime = {
  readonly adoptionRunner: AdoptionPhaseRunner;
};

// ----- BuildRuntimeOptions --------------------------------------------------

/**
 * The injected dependencies `buildRuntime` requires. `registry` is the
 * loaded ProcessorRegistry; `resolveGrants` returns the broker-resolved
 * grant set for a given processor id (typically derived from the vault's
 * capability policy against the bundle manifest); `extensionIdFor` maps a
 * processor id to its originating bundle id (for the `Dome-Extension`
 * trailer on engine commits via `makeRunContext`); `resolveTree` resolves
 * a candidate commit OID to its tree OID (the per-iteration Snapshot the
 * processor reads from).
 *
 * `resolveTree` is injected (rather than imported from `../git`) so this
 * runtime file stays I/O-free at the type layer. Whoever calls
 * `buildRuntime` (today: `src/vault.ts` or a future processors/index.ts)
 * wires the resolver against the live git boundary.
 */
export type BuildRuntimeOptions = {
  readonly registry: ProcessorRegistry;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly resolveTree: (commit: CommitOid) => Promise<TreeOid>;
};

// ----- buildRuntime ---------------------------------------------------------

/**
 * Build a frozen `ProcessorRuntime` handle. The returned `adoptionRunner`
 * satisfies the engine's `AdoptionPhaseRunner` contract: given the
 * per-iteration `(candidate, changedPaths, signals, iteration, proposal,
 * vault)` tuple, it walks the registry's adoption-phase processors, fires
 * each whose triggers match the signals, constructs a `ProcessorContext`,
 * invokes `processor.run`, and returns one `RunnerResult` per firing
 * processor.
 *
 * Per-processor exceptions are caught and synthesized into a
 * `DiagnosticEffect` with `code: "processor-threw"` (severity `error`,
 * non-blocking). The loop does not crash on a single misbehaving processor.
 *
 * Returned values are frozen: the outer results array, each `RunnerResult`,
 * and each effect list are `Object.freeze`d so downstream consumers (the
 * adoption loop, test mocks) cannot mutate the runner's output.
 */
export function buildRuntime(opts: BuildRuntimeOptions): ProcessorRuntime {
  const {
    registry,
    resolveGrants,
    extensionIdFor,
    resolveTree,
  } = opts;

  const adoptionRunner: AdoptionPhaseRunner = async (input) => {
    const adoptionProcessors = registry.byPhase("adoption");
    if (adoptionProcessors.length === 0) {
      return Object.freeze([]);
    }

    // Resolve the candidate tree OID once per iteration — every firing
    // processor sees the same Snapshot for the same candidate.
    const tree = await resolveTree(input.candidate);
    const snapshot: Snapshot = Object.freeze({
      commit: input.candidate,
      tree,
    });

    const results: RunnerResult[] = [];
    for (const processor of adoptionProcessors) {
      const matches = matchTriggers(processor.triggers, input.signals);
      if (matches.length === 0) continue;

      const declared = processor.capabilities;
      const granted = resolveGrants(processor.id);
      const extensionId = extensionIdFor(processor.id);
      const runId = makeRunContext({
        extensionId,
        base: input.proposal.base,
        sourceHead: input.proposal.head,
      }).runId;

      const ctxInput: ProcessorContextInput<AdoptionRunInput> = {
        snapshot,
        changedPaths: input.changedPaths,
        proposal: input.proposal,
        runId,
        input: Object.freeze({
          kind: "adoption" as const,
          matchedTriggers: matches,
        }),
        // `modelInvoke` intentionally unset — adoption-phase processors
        // never receive a model handle (processors.md §"Adoption phase").
      };
      const ctx = makeProcessorContext(ctxInput);

      const effects = await runOneProcessor(processor.run, ctx, processor.id);

      results.push(
        Object.freeze({
          processorId: processor.id,
          declared,
          granted,
          effects,
        }),
      );
    }

    return Object.freeze(results);
  };

  return Object.freeze({ adoptionRunner });
}

// ----- internals ------------------------------------------------------------

/**
 * Invoke a processor's `run` method with try/catch insulation. A thrown
 * exception (including async rejection) is synthesized into a single
 * `DiagnosticEffect` with `code: "processor-threw"` and severity `error`
 * (non-blocking — a single misbehaving processor should not refuse
 * adoption; the operator surface is the run ledger + telemetry).
 *
 * The processor's static `TInput` is its own concern; the runtime stores
 * processors as `Processor<unknown>` (per registry.ts §"Type-erased at
 * storage"). The cast from `ProcessorContext<AdoptionRunInput>` to
 * `ProcessorContext<unknown>` is structurally safe — `unknown` is the top
 * type, and `AdoptionRunInput` is assignable to it; the cast is needed
 * because `ProcessorContext` is invariant in `TInput`.
 */
async function runOneProcessor(
  run: (ctx: ProcessorContext<unknown>) => Promise<ReadonlyArray<Effect>>,
  ctx: ProcessorContext<AdoptionRunInput>,
  processorId: string,
): Promise<ReadonlyArray<Effect>> {
  try {
    const effects = await run(ctx as ProcessorContext<unknown>);
    return Object.freeze([...effects]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const synthesized: DiagnosticEffect = diagnosticEffect({
      severity: "error",
      code: "processor-threw",
      message: `Processor ${processorId} threw during adoption-phase run: ${message}`,
      sourceRefs: [],
    });
    return Object.freeze([synthesized]);
  }
}
