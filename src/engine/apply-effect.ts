// applyEffect: the single applier chokepoint.
//
// Every Effect emitted by a processor flows through this router. It performs
// two checks in order — (1) phase compatibility, (2) capability enforcement —
// and then dispatches to one of seven injected sinks via an exhaustive
// `switch` on `Effect.kind`. The router itself is pure: it owns no I/O and
// holds no state; the wired sinks (projection store, ledger, outbox, etc.)
// live in Phase 4 + Phase 8.
//
// Normative references:
//   - docs/wiki/specs/effects.md §"The Effect union"
//   - docs/wiki/matrices/effect-router-targets.md
//   - docs/wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER.md
//
// Structural fence: TypeScript's `never`-type exhaustiveness check on the
// `switch (effect.kind)` makes "adding an eighth Effect kind without a route"
// a compile error here. The capability broker (`./capability-broker`) is
// called from this file and nowhere else; the
// [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]] import-graph test
// asserts that property.
//
// v1 Phase 2 scope:
//   - This file is the pure routing layer. The sinks are *injected* via the
//     `ApplyEffectSinks` shape; `noopSinks()` returns a no-op implementation
//     suitable for unit tests and Phase 2 standalone validation.
//   - The garden-phase PatchEffect → "spawn a new Proposal" semantics
//     (matrix §"Garden-emitted Proposals") is the responsibility of the
//     `applyPatch` sink, not this router. The router calls `sinks.applyPatch`
//     for both adoption- and garden-phase patches; the sink (or `adopt.ts`)
//     decides whether to apply to a candidate tree (adoption) or spawn a new
//     Proposal (garden). This keeps the router a pure dispatcher.
//   - In the adoption phase, a DiagnosticEffect with `severity: "block"` is
//     *recorded* via `sinks.recordDiagnostic` and the router returns
//     `outcome: "applied"`. The blocking itself happens one layer up, in
//     `adopt.ts`'s loop, which inspects the returned diagnostics and refuses
//     to advance the adopted ref on any `severity: "block"`.
//
// House-style notes (matches src/core/source-ref.ts, src/core/effect.ts,
// src/engine/capability-broker.ts, src/engine/compile-range.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Optional fields use `field?: T` (not `T | undefined`) for
//     `exactOptionalPropertyTypes` cleanliness.
//   - Exhaustive `switch` on `Effect.kind` with a `never`-typed catch-all.
//   - Object.freeze on returned result objects so misbehaving callers fail
//     loudly at runtime rather than silently corrupting downstream state.
//   - Imports limited to pure types from `../core/` plus the
//     `./capability-broker` decision function. No filesystem, git, sqlite,
//     or network dependencies in this file.

import type {
  DiagnosticEffect,
  Effect,
  ExternalActionEffect,
  FactEffect,
  JobEffect,
  PatchEffect,
  QuestionEffect,
  ViewEffect,
} from "../core/effect";
import { diagnosticEffect } from "../core/effect";
import type { Capability, ProcessorPhase } from "../core/processor";
import { enforceCapability } from "./capability-broker";

// ----- ApplyEffectSinks -----------------------------------------------------

/**
 * The injected dependency surface. Each sink is a callback the wired engine
 * runtime provides (Phase 4 wires the projection-store sinks; Phase 8 wires
 * the ledger + outbox). For unit tests and Phase 2 standalone validation,
 * see `noopSinks()` below.
 *
 * Sinks return `void` (well, `Promise<void>`): the routing layer does not
 * branch on sink results. Errors a sink throws propagate up to the caller —
 * `applyEffect` does not catch.
 */
export type ApplyEffectSinks = {
  /**
   * PatchEffect — applied to the candidate tree (adoption phase) or used to
   * spawn a new Proposal (garden phase, per
   * [[wiki/specs/proposals]] §"Garden-emitted Proposals"). The router passes
   * the effect through verbatim; the wired sink decides which behavior.
   */
  readonly applyPatch: (input: {
    readonly effect: PatchEffect;
    readonly processorId: string;
    readonly runId: string;
  }) => Promise<void>;

  /** DiagnosticEffect — written to `projection_store.diagnostics`. */
  readonly recordDiagnostic: (input: {
    readonly effect: DiagnosticEffect;
    readonly processorId: string;
    readonly runId: string;
    readonly proposalId: string | null;
  }) => Promise<void>;

  /** FactEffect — written to `projection_store.facts`. */
  readonly recordFact: (input: {
    readonly effect: FactEffect;
    readonly processorId: string;
    readonly runId: string;
  }) => Promise<void>;

  /** QuestionEffect — written to `projection_store.questions`. */
  readonly recordQuestion: (input: {
    readonly effect: QuestionEffect;
    readonly processorId: string;
    readonly runId: string;
  }) => Promise<void>;

  /** JobEffect — enqueued in the runtime job queue. */
  readonly enqueueJob: (input: {
    readonly effect: JobEffect;
    readonly processorId: string;
    readonly runId: string;
  }) => Promise<void>;

  /**
   * ExternalActionEffect — inserted into the outbox + dispatched. Pinned by
   * [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]].
   */
  readonly dispatchExternal: (input: {
    readonly effect: ExternalActionEffect;
    readonly processorId: string;
    readonly runId: string;
  }) => Promise<void>;

  /** ViewEffect — captured for return to the view-phase caller. */
  readonly captureView: (input: {
    readonly effect: ViewEffect;
    readonly processorId: string;
    readonly runId: string;
  }) => Promise<void>;
};

// ----- ApplyEffectResult ----------------------------------------------------

/**
 * The router's verdict for one Effect.
 *
 *   - `applied`           — the effect was routed to its sink. `appliedEffect`
 *                           carries the effect that actually reached the sink
 *                           (the original, or the broker's downgrade).
 *   - `downgraded`        — the broker downgraded the effect; the rewritten
 *                           shape was routed. `diagnostics` carries the
 *                           downgrade-surprise diagnostic.
 *   - `denied`            — the broker denied the effect; nothing routed.
 *                           `diagnostics` carries the deny diagnostic.
 *   - `rejected-by-phase` — the phase-compatibility check rejected the
 *                           effect; the broker was not consulted. Nothing
 *                           routed. `diagnostics` carries a `phase-mismatch`
 *                           diagnostic.
 *
 * `appliedEffect` is `null` for `denied` and `rejected-by-phase`. For
 * `applied` and `downgraded` it is non-null and equals the effect handed to
 * the sink.
 *
 * `diagnostics` is empty for plain `applied`; it carries the broker's
 * diagnostic for `downgraded` / `denied` and the router's `phase-mismatch`
 * diagnostic for `rejected-by-phase`. The diagnostics are *not* sent to
 * `sinks.recordDiagnostic` by this router — the caller (adopt.ts) appends
 * them to the run's effect stream so they flow through `applyEffect` itself
 * on a subsequent call (and thus get recorded with full capability +
 * phase-check provenance).
 */
export type ApplyEffectResult = {
  readonly outcome: "applied" | "downgraded" | "denied" | "rejected-by-phase";
  readonly appliedEffect: Effect | null;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
};

// ----- noopSinks ------------------------------------------------------------

/**
 * Factory returning a sinks object whose every callback resolves to
 * `undefined` without side-effects. Used by Phase 2 unit tests and any
 * caller that wants to exercise the router's routing logic without wiring
 * real I/O.
 *
 * A fresh object is returned per call so test isolation is preserved
 * (callers commonly wrap individual sinks in spies / mocks).
 */
export function noopSinks(): ApplyEffectSinks {
  return {
    applyPatch: async () => undefined,
    recordDiagnostic: async () => undefined,
    recordFact: async () => undefined,
    recordQuestion: async () => undefined,
    enqueueJob: async () => undefined,
    dispatchExternal: async () => undefined,
    captureView: async () => undefined,
  };
}

// ----- applyEffect ----------------------------------------------------------

/**
 * The single applier chokepoint. Routes one Effect through phase
 * compatibility + capability enforcement + the matching sink.
 *
 * Ordering invariant: phase compatibility is checked *before* capability
 * enforcement. An effect rejected by phase is discarded without consulting
 * the broker (the broker's per-kind decisions are only meaningful for
 * phase-compatible effects).
 */
export async function applyEffect(opts: {
  readonly effect: Effect;
  readonly processorId: string;
  readonly runId: string;
  readonly proposalId: string | null;
  readonly phase: ProcessorPhase;
  readonly declared: ReadonlyArray<Capability>;
  readonly granted: ReadonlyArray<Capability>;
  readonly sinks: ApplyEffectSinks;
}): Promise<ApplyEffectResult> {
  // 1. Phase compatibility.
  if (!isPhaseCompatible(opts.effect, opts.phase)) {
    return rejectedByPhase(opts.effect, opts.phase);
  }

  // 2. Capability enforcement.
  const verdict = enforceCapability(opts.effect, opts.declared, opts.granted);
  if (verdict.kind === "deny") {
    return frozen({
      outcome: "denied",
      appliedEffect: null,
      diagnostics: Object.freeze([verdict.diagnostic]),
    });
  }
  const routed: Effect =
    verdict.kind === "downgrade" ? verdict.rewrittenEffect : opts.effect;
  const verdictDiagnostics: ReadonlyArray<DiagnosticEffect> =
    verdict.kind === "downgrade"
      ? Object.freeze([verdict.diagnostic])
      : EMPTY_DIAGNOSTICS;

  // 3. Route to the matching sink. Exhaustive on Effect.kind.
  await routeToSink(routed, opts);

  return frozen({
    outcome: verdict.kind === "downgrade" ? "downgraded" : "applied",
    appliedEffect: routed,
    diagnostics: verdictDiagnostics,
  });
}

// ----- phase compatibility --------------------------------------------------

/**
 * Per docs/wiki/matrices/effect-router-targets.md, the (kind, phase) cells
 * marked "Rejected: phase-mismatch":
 *
 *   - adoption: JobEffect, ExternalActionEffect, ViewEffect
 *   - garden:   ViewEffect
 *   - view:     PatchEffect, DiagnosticEffect (severity: "block"),
 *               FactEffect, QuestionEffect, JobEffect, ExternalActionEffect
 *
 * Every other (kind, phase) pair is routed normally.
 */
function isPhaseCompatible(effect: Effect, phase: ProcessorPhase): boolean {
  switch (phase) {
    case "adoption":
      return (
        effect.kind !== "job" &&
        effect.kind !== "external" &&
        effect.kind !== "view"
      );
    case "garden":
      return effect.kind !== "view";
    case "view":
      if (
        effect.kind === "patch" ||
        effect.kind === "fact" ||
        effect.kind === "question" ||
        effect.kind === "job" ||
        effect.kind === "external"
      ) {
        return false;
      }
      if (effect.kind === "diagnostic" && effect.severity === "block") {
        return false;
      }
      return true;
  }
}

function rejectedByPhase(
  effect: Effect,
  phase: ProcessorPhase,
): ApplyEffectResult {
  return frozen({
    outcome: "rejected-by-phase",
    appliedEffect: null,
    diagnostics: Object.freeze([
      diagnosticEffect({
        severity: "error",
        code: "phase-mismatch",
        message: `Processor in phase '${phase}' cannot emit effect of kind '${effect.kind}'`,
        sourceRefs: [],
      }),
    ]),
  });
}

// ----- routing dispatch -----------------------------------------------------

/**
 * Exhaustive `switch` on `Effect.kind` — the structural fence behind
 * [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]. The `never`-typed
 * `_exhaustive` makes adding an eighth Effect kind here a compile error
 * until every kind has a route.
 */
async function routeToSink(
  effect: Effect,
  opts: {
    readonly processorId: string;
    readonly runId: string;
    readonly proposalId: string | null;
    readonly sinks: ApplyEffectSinks;
  },
): Promise<void> {
  switch (effect.kind) {
    case "patch":
      await opts.sinks.applyPatch({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
      });
      return;
    case "diagnostic":
      await opts.sinks.recordDiagnostic({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
        proposalId: opts.proposalId,
      });
      return;
    case "fact":
      await opts.sinks.recordFact({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
      });
      return;
    case "question":
      await opts.sinks.recordQuestion({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
      });
      return;
    case "job":
      await opts.sinks.enqueueJob({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
      });
      return;
    case "external":
      await opts.sinks.dispatchExternal({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
      });
      return;
    case "view":
      await opts.sinks.captureView({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
      });
      return;
  }
  // Exhaustive switch — TS verifies via the `never` exhaustiveness check.
  // Adding an eighth Effect kind here is a compile error until every branch
  // above is updated.
  const _exhaustive: never = effect;
  return _exhaustive;
}

// ----- frozen-result helpers ------------------------------------------------

const EMPTY_DIAGNOSTICS: ReadonlyArray<DiagnosticEffect> = Object.freeze([]);

/**
 * Freeze the result object so misbehaving callers (or downstream layers that
 * persist results to the run ledger) cannot mutate the verdict after the
 * fact. The diagnostics array is frozen at construction in every call site.
 */
function frozen(result: ApplyEffectResult): ApplyEffectResult {
  return Object.freeze(result);
}
