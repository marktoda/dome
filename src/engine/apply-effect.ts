// applyEffect: the generic effect applier route.
//
// Every Effect emitted by a processor flows through this router. It performs
// two checks in order — (1) phase compatibility, (2) capability enforcement —
// and then dispatches to one of seven injected sinks via an exhaustive
// `switch` on `Effect.kind`. The router itself is pure: it owns no I/O and
// holds no state; the wired sinks (projection store, ledger, outbox, etc.)
// live in Phase 4 + Phase 8. Garden-phase PatchEffects are the one route
// owned by `garden-patch-router.ts`, because their destination is
// sub-Proposal construction rather than an inline sink.
//
// Normative references:
//   - docs/wiki/specs/effects.md §"The Effect union"
//   - docs/wiki/matrices/effect-router-targets.md
//   - docs/wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER.md
//
// Structural fence: TypeScript's `never`-type exhaustiveness check on the
// `switch (effect.kind)` makes "adding an eighth Effect kind without a route"
// a compile error here for the generic sink routes. The capability broker
// (`./capability-broker`) is also called by `garden-patch-router.ts` for
// garden PatchEffects; both call sites are inside the engine routing layer.
//
// v1 Phase 2 scope:
//   - This file is the pure routing layer. The sinks are *injected* via the
//     `ApplyEffectSinks` shape; `noopSinks()` returns a no-op implementation
//     suitable for unit tests and Phase 2 standalone validation.
//   - Engine-created diagnostics returned by this router are also recorded
//     through `sinks.recordDiagnostic` before return. Callers still inspect
//     the returned array for control flow, but they do not need to remember a
//     second persistence step.
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
//     `./capability-broker` decision function and the pure capability-use
//     label helper. No filesystem, git, sqlite, or network dependencies in
//     this file.

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
import type { CommitOid } from "../core/source-ref";
import { enforceCapability } from "./capability-broker";
import { recordDiagnosticsViaSink } from "./diagnostics";
import {
  capabilityUseForEffect,
  type EffectCapabilityUse,
} from "./effect-capability-use";
import type { RunId } from "./runner-contract";

// ----- ApplyEffectSinks -----------------------------------------------------

/**
 * The injected dependency surface. Each sink is a callback the wired engine
 * runtime provides (Phase 4 wires the projection-store sinks; Phase 8 wires
 * the ledger + outbox). For unit tests and Phase 2 standalone validation,
 * see `noopSinks()` below.
 *
 * Most sinks return `void` (well, `Promise<void>`): the routing layer does
 * not branch on their results. The exception is `applyPatch`, which since
 * Phase 12a returns the new candidate's commit OID (or `null` when the
 * patch didn't apply) — the adoption loop reads this on `ApplyEffectResult.
 * newCandidate` and advances its candidate variable accordingly. Errors a
 * sink throws propagate up to the caller — `applyEffect` does not catch.
 */
export type ApplyEffectSinks = {
  /**
   * PatchEffect — applied to the candidate tree (adoption phase) or used to
   * spawn a new Proposal (garden phase, per
   * [[wiki/specs/proposals]] §"Garden-emitted Proposals"). The router passes
   * the effect through verbatim; the wired sink decides which behavior.
   *
   * Returns the new candidate's commit OID when the sink advanced the
   * candidate (the adoption-phase candidate-tree mutator path), or `null`
   * when the sink dropped the effect or the patch didn't apply (placeholder
   * sink, malformed diff, hunk-doesn't-apply). The adoption loop reads
   * `ApplyEffectResult.newCandidate` and threads the returned OID into the
   * next iteration's candidate. Pinned by Phase 12a's
   * candidate-OID-progression contract.
   */
  readonly applyPatch: (input: {
    readonly effect: PatchEffect;
    readonly processorId: string;
    readonly runId: RunId;
    readonly candidate: CommitOid;
  }) => Promise<CommitOid | null>;

  /** DiagnosticEffect — written to `projection_store.diagnostics`. */
  readonly recordDiagnostic: (input: {
    readonly effect: DiagnosticEffect;
    readonly processorId: string;
    readonly runId?: RunId;
    readonly proposalId: string | null;
  }) => Promise<void>;

  /**
   * Optional projection-maintenance hook. After a processor re-checks a set of
   * paths, the engine passes the diagnostic effects it emitted so the sink can
   * mark older unresolved diagnostics for those paths as resolved.
   */
  readonly resolveDiagnostics?: (input: {
    readonly processorId: string;
    readonly runId: RunId;
    readonly inspectedPaths: ReadonlyArray<string>;
    readonly emittedDiagnostics: ReadonlyArray<DiagnosticEffect>;
  }) => Promise<void>;

  /** FactEffect — written to `projection_store.facts`. */
  readonly recordFact: (input: {
    readonly effect: FactEffect;
    readonly processorId: string;
    readonly runId: RunId;
  }) => Promise<void>;

  /** QuestionEffect — written to `projection_store.questions`. */
  readonly recordQuestion: (input: {
    readonly effect: QuestionEffect;
    readonly processorId: string;
    readonly runId: RunId;
  }) => Promise<void>;

  /** JobEffect — enqueued in the runtime job queue. */
  readonly enqueueJob: (input: {
    readonly effect: JobEffect;
    readonly processorId: string;
    readonly runId: RunId;
  }) => Promise<void>;

  /**
   * ExternalActionEffect — inserted into the outbox + dispatched. Pinned by
   * [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]].
   */
  readonly dispatchExternal: (input: {
    readonly effect: ExternalActionEffect;
    readonly processorId: string;
    readonly runId: RunId;
  }) => Promise<void>;

  /** ViewEffect — captured for return to the view-phase caller. */
  readonly captureView: (input: {
    readonly effect: ViewEffect;
    readonly processorId: string;
    readonly runId: RunId;
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
 *   - `blocked-for-review` — an adoption-phase PatchEffect resolved to
 *                           `mode: "propose"` after broker enforcement.
 *                           Nothing routed; `diagnostics` carries a block
 *                           diagnostic that stops adoption.
 *
 * `appliedEffect` is `null` for `denied` and `rejected-by-phase`. For
 * `blocked-for-review`, `denied`, and `rejected-by-phase` it is null. For
 * `applied` and `downgraded` it is non-null and equals the effect handed to
 * the sink.
 *
 * `diagnostics` is empty for plain `applied`; it carries the broker's
 * diagnostic for `downgraded` / `denied` and the router's `phase-mismatch`
 * diagnostic for `rejected-by-phase`. Returned diagnostics have already
 * been sent to `sinks.recordDiagnostic`; callers inspect them for control
 * flow and user output, not for a second persistence pass.
 */
export type ApplyEffectResult = {
  readonly outcome:
    | "applied"
    | "downgraded"
    | "denied"
    | "rejected-by-phase"
    | "blocked-for-review";
  readonly appliedEffect: Effect | null;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
  /**
   * The structured capability-use record for the run ledger. Populated for
   * every effect kind the broker actually enforces against a named
   * capability — `patch` (capability=`patch.auto` | `patch.propose`,
   * resource=touched path), `fact` (capability=`graph.write`,
   * resource=predicate namespace), `question` (capability=`question.ask`,
   * resource=null), `external` (capability=`external:<name>`,
   * resource=effect.capability).
   *
   * Undefined for effect kinds the broker passes through without enforcement
   * (`diagnostic`, `view`) and for
   * `rejected-by-phase` outcomes (the broker was never consulted, so no
   * capability dimension exists). The engine's adoption loop forwards
   * populated records to `recordEffectCapabilityUse` per
   * [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]] §"Structural
   * enforcement" §2.
   */
  readonly capabilityUse?: EffectCapabilityUse;
  /**
   * When the routed effect was a successful PatchEffect (broker outcome
   * `applied` or `downgraded`) AND the wired `applyPatch` sink returned a
   * non-null OID, this carries the new candidate's commit OID. The
   * adoption loop reads this to advance its `candidate` variable for the
   * next iteration, replacing the Phase-2 behavior of re-reading HEAD via
   * `currentSha`. Pinned by Phase 12a's candidate-OID-progression contract.
   *
   * Absent for every other outcome — non-patch effects, denied patches,
   * phase-rejected patches, and successful patches whose sink returned
   * `null` (placeholder sink, malformed diff, hunk-doesn't-apply).
   */
  readonly newCandidate?: CommitOid;
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
    applyPatch: async () => null,
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
 * The generic effect applier route. Routes one Effect through phase
 * compatibility + capability enforcement + the matching sink. Garden
 * PatchEffects are routed by `garden-patch-router.ts` because they spawn
 * sub-Proposals instead of writing through the patch sink directly.
 *
 * Ordering invariant: phase compatibility is checked *before* capability
 * enforcement. An effect rejected by phase is discarded without consulting
 * the broker (the broker's per-kind decisions are only meaningful for
 * phase-compatible effects).
 */
export async function applyEffect(opts: {
  readonly effect: Effect;
  readonly processorId: string;
  readonly runId: RunId;
  readonly proposalId: string | null;
  readonly phase: ProcessorPhase;
  readonly declared: ReadonlyArray<Capability>;
  readonly granted: ReadonlyArray<Capability>;
  readonly sinks: ApplyEffectSinks;
  /**
   * The current adoption-loop candidate OID. Threaded into the `applyPatch`
   * sink so the candidate-tree mutator can apply the patch against the
   * correct base commit. Other effect kinds ignore it. Pinned by Phase
   * 12a's candidate-OID-progression contract (see
   * docs/wiki/specs/adoption.md §"The fixed-point adoption loop").
   */
  readonly candidate: CommitOid;
}): Promise<ApplyEffectResult> {
  // 1. Phase compatibility.
  if (!isPhaseCompatible(opts.effect, opts.phase)) {
    const rejected = rejectedByPhase(opts.effect, opts.phase);
    await recordDiagnosticsViaSink({
      sinks: opts.sinks,
      diagnostics: rejected.diagnostics,
      processorId: opts.processorId,
      proposalId: opts.proposalId,
      runId: opts.runId,
    });
    return rejected;
  }

  // 2. Capability enforcement.
  const verdict = enforceCapability(opts.effect, opts.declared, opts.granted);
  if (verdict.kind === "deny") {
    const diagnostic =
      opts.phase === "adoption" && opts.effect.kind === "patch"
        ? diagnosticEffect({
            severity: "block",
            code: verdict.diagnostic.code,
            message: verdict.diagnostic.message,
            sourceRefs: verdict.diagnostic.sourceRefs,
          })
        : verdict.diagnostic;
    const denied = frozen({
      outcome: "denied",
      appliedEffect: null,
      diagnostics: Object.freeze([diagnostic]),
      ...capabilityUseField(opts.effect, "denied"),
    });
    await recordDiagnosticsViaSink({
      sinks: opts.sinks,
      diagnostics: denied.diagnostics,
      processorId: opts.processorId,
      proposalId: opts.proposalId,
      runId: opts.runId,
    });
    return denied;
  }
  const routed: Effect =
    verdict.kind === "downgrade" ? verdict.rewrittenEffect : opts.effect;
  const verdictDiagnostics: ReadonlyArray<DiagnosticEffect> =
    verdict.kind === "downgrade"
      ? Object.freeze([verdict.diagnostic])
      : EMPTY_DIAGNOSTICS;

  // Adoption can auto-apply only auto-mode patches. A propose-mode patch
  // means the processor is asking for human review; applying it inside the
  // merge gate would silently bypass that review boundary. Run this after
  // broker enforcement so denied proposals remain denied, and auto→propose
  // downgrades still ledger the original `patch.auto` attempt as downgraded.
  if (
    opts.phase === "adoption" &&
    routed.kind === "patch" &&
    routed.mode === "propose"
  ) {
    const reviewDiagnostic = diagnosticEffect({
      severity: "block",
      code: "patch.propose.requires-review",
      message: `PatchEffect from ${opts.processorId} requires review before adoption: ${routed.reason}`,
      sourceRefs: routed.sourceRefs,
    });
    const capabilityOutcome: "allowed" | "downgraded" =
      verdict.kind === "downgrade" ? "downgraded" : "allowed";
    const blocked = frozen({
      outcome: "blocked-for-review",
      appliedEffect: null,
      diagnostics: Object.freeze([...verdictDiagnostics, reviewDiagnostic]),
      ...capabilityUseField(opts.effect, capabilityOutcome),
    });
    await recordDiagnosticsViaSink({
      sinks: opts.sinks,
      diagnostics: blocked.diagnostics,
      processorId: opts.processorId,
      proposalId: opts.proposalId,
      runId: opts.runId,
    });
    return blocked;
  }

  // 3. Route to the matching sink. Exhaustive on Effect.kind.
  const sinkResult = await routeToSink(routed, opts);

  const outcome: "downgraded" | "allowed" =
    verdict.kind === "downgrade" ? "downgraded" : "allowed";
  // The capability dimension is described in terms of the ORIGINAL effect
  // (the broker enforced against the processor's emission, not the
  // downgraded shape). For a `patch.auto` → `patch.propose` downgrade, the
  // ledger row records `capability: "patch.auto"` with `outcome:
  // "downgraded"` — that's the surface a "this processor tried to auto-
  // apply but lacked the grant" audit query needs.
  const newCandidate =
    routed.kind === "patch" && sinkResult.newCandidate !== null
      ? sinkResult.newCandidate
      : undefined;
  const result = frozen({
    outcome: verdict.kind === "downgrade" ? "downgraded" : "applied",
    appliedEffect: routed,
    diagnostics: verdictDiagnostics,
    ...capabilityUseField(opts.effect, outcome),
    ...(newCandidate !== undefined ? { newCandidate } : {}),
  });
  if (result.diagnostics.length > 0) {
    await recordDiagnosticsViaSink({
      sinks: opts.sinks,
      diagnostics: result.diagnostics,
      processorId: opts.processorId,
      proposalId: opts.proposalId,
      runId: opts.runId,
    });
  }
  return result;
}

function capabilityUseField(
  effect: Effect,
  outcome: "allowed" | "downgraded" | "denied",
): { capabilityUse?: EffectCapabilityUse } {
  const capabilityUse = capabilityUseForEffect(effect, outcome);
  return capabilityUse === null ? {} : { capabilityUse };
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
    readonly runId: RunId;
    readonly proposalId: string | null;
    readonly sinks: ApplyEffectSinks;
    readonly candidate: CommitOid;
  },
): Promise<{ readonly newCandidate: CommitOid | null }> {
  switch (effect.kind) {
    case "patch": {
      const newCandidate = await opts.sinks.applyPatch({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
        candidate: opts.candidate,
      });
      return { newCandidate };
    }
    case "diagnostic":
      await opts.sinks.recordDiagnostic({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
        proposalId: opts.proposalId,
      });
      return { newCandidate: null };
    case "fact":
      await opts.sinks.recordFact({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
      });
      return { newCandidate: null };
    case "question":
      await opts.sinks.recordQuestion({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
      });
      return { newCandidate: null };
    case "job":
      await opts.sinks.enqueueJob({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
      });
      return { newCandidate: null };
    case "external":
      await opts.sinks.dispatchExternal({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
      });
      return { newCandidate: null };
    case "view":
      await opts.sinks.captureView({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
      });
      return { newCandidate: null };
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
