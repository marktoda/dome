// applyEffect: the generic effect applier route.
//
// Every Effect emitted by a processor flows through this router. It performs
// two checks in order — (1) phase compatibility, (2) capability enforcement —
// and then dispatches to one of the injected sinks via an exhaustive
// `switch` on `Effect.kind`. The router itself is pure: it owns no I/O and
// holds no state; the wired sinks (projection store, ledger, outbox, etc.)
// live in Phase 4 + Phase 8. Garden-phase PatchEffects flow through this
// router like every other effect: the broker is enforced here, then an
// authorized auto-mode patch resolves to the `queued-for-spawn` outcome (it is
// not written through an inline sink) and the garden orchestrator constructs
// the sub-Proposal from it.
//
// Normative references:
//   - docs/wiki/specs/effects.md §"The Effect union"
//   - docs/wiki/matrices/effect-router-targets.md
//   - docs/wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER.md
//
// Structural fence: TypeScript's `never`-type exhaustiveness check on the
// `switch (effect.kind)` makes adding an Effect kind without a route
// a compile error here for the generic sink routes. The capability broker
// (`./capability-broker`) is called only from this module — one chokepoint for
// every effect kind and phase, garden PatchEffects included.
//
// v1 scope:
//   - This file is the pure routing layer. The sinks are *injected* via the
//     `ApplyEffectSinks` shape; `noopSinks()` returns a no-op implementation
//     suitable for unit tests and Phase 2 standalone validation.
//   - Engine-created diagnostics returned by this router are also recorded
//     through `sinks.recordDiagnostic` before return. Callers still inspect
//     the returned array for control flow, but they do not need to remember a
//     second persistence step.
//   - Garden-phase PatchEffects cross this router like any other effect: the
//     broker is enforced here, then an authorized auto-mode patch resolves to
//     `queued-for-spawn` (it is NOT written through the patch sink). The garden
//     orchestrator reads `appliedEffect` and spawns a sub-Proposal. Propose-mode
//     and downgraded garden patches enqueue a durable pending-proposal row
//     (`queued-for-review`) when the optional `enqueueProposal` sink is wired;
//     when it isn't (sink-less harnesses, e.g. `dome run`), they are surfaced
//     and dropped instead (`blocked-for-review` /
//     `garden.patch-propose-review-unavailable`).
//   - In the adoption phase, a DiagnosticEffect with `severity: "block"` is
//     *recorded* via `sinks.recordDiagnostic` and the router returns
//     `outcome: "applied"`. The blocking itself happens one layer up, in
//     `adopt.ts`'s loop, which inspects the returned diagnostics and refuses
//     to advance the adopted ref on any `severity: "block"`.
//
// House-style notes (matches src/core/source-ref.ts, src/core/effect.ts,
// src/engine/core/capability-broker.ts, src/engine/core/compile-range.ts):
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
  OutboxRecoveryEffect,
  PatchEffect,
  QuarantineRecoveryEffect,
  QuestionEffect,
  RunRecoveryEffect,
  SearchDocumentEffect,
  ViewEffect,
} from "../../core/effect";
import { diagnosticEffect } from "../../core/effect";
import type { Capability, ProcessorPhase } from "../../core/processor";
import type { CommitOid, SourceRef } from "../../core/source-ref";
import { enforceCapability, type DeniedCapability } from "./capability-broker";
import { recordDiagnosticsViaSink } from "./diagnostics";
import {
  capabilityUseForEffect,
  type EffectCapabilityUse,
} from "./effect-capability-use";
import type { RunId } from "./runner-contract";

type EffectKind = Effect["kind"];
type PhaseCompatibilityTable = {
  readonly [K in EffectKind]: Readonly<Record<ProcessorPhase, boolean>>;
};

export const EFFECT_PHASE_COMPATIBILITY = Object.freeze({
  patch: Object.freeze({
    adoption: true,
    garden: true,
    view: false,
  }),
  diagnostic: Object.freeze({
    adoption: true,
    garden: true,
    view: true,
  }),
  fact: Object.freeze({
    adoption: true,
    garden: true,
    view: false,
  }),
  "search-document": Object.freeze({
    adoption: true,
    garden: true,
    view: false,
  }),
  question: Object.freeze({
    adoption: true,
    garden: true,
    view: false,
  }),
  external: Object.freeze({
    adoption: false,
    garden: true,
    view: false,
  }),
  "outbox-recovery": Object.freeze({
    adoption: false,
    garden: true,
    view: false,
  }),
  "quarantine-recovery": Object.freeze({
    adoption: false,
    garden: true,
    view: false,
  }),
  "run-recovery": Object.freeze({
    adoption: false,
    garden: true,
    view: false,
  }),
  view: Object.freeze({
    adoption: false,
    garden: false,
    view: true,
  }),
} satisfies PhaseCompatibilityTable);

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
   * Optional projection-maintenance hook. After a processor or engine-owned
   * recovery path re-checks a scope, the engine passes the diagnostic effects
   * it still emits so the sink can mark older unresolved diagnostics for that
   * scope as resolved. Processor calls include `runId`; engine-owned recovery
   * calls may not have a processor ledger row.
   */
  readonly resolveDiagnostics?: (input: {
    readonly processorId: string;
    readonly runId?: RunId;
    readonly inspectedPaths: ReadonlyArray<string>;
    readonly emittedDiagnostics: ReadonlyArray<DiagnosticEffect>;
  }) => Promise<void>;

  /**
   * Optional projection-maintenance hook. Before routing a successful
   * processor's new FactEffects, the engine tells the sink which paths the
   * processor re-inspected so page-subject extracted facts can be replaced
   * deterministically.
   */
  readonly resolveFacts?: (input: {
    readonly processorId: string;
    readonly runId: RunId;
    readonly inspectedPaths: ReadonlyArray<string>;
  }) => Promise<void>;

  /**
   * Optional projection-maintenance hook. After a processor re-checks a set of
   * paths, the engine passes the QuestionEffects it emitted so the sink can
   * remove older derived questions for those paths when they were not
   * re-emitted.
   */
  readonly resolveQuestions?: (input: {
    readonly processorId: string;
    readonly runId: RunId;
    readonly inspectedPaths: ReadonlyArray<string>;
    readonly emittedQuestions: ReadonlyArray<QuestionEffect>;
  }) => Promise<void>;

  /** FactEffect — written to `projection_store.facts`. */
  readonly recordFact: (input: {
    readonly effect: FactEffect;
    readonly processorId: string;
    readonly runId: RunId;
  }) => Promise<void>;

  /** SearchDocumentEffect — written to `projection_store.fts_documents`. */
  readonly recordSearchDocument: (input: {
    readonly effect: SearchDocumentEffect;
    readonly processorId: string;
    readonly runId: RunId;
  }) => Promise<void>;

  /** QuestionEffect — written to `projection_store.questions`. */
  readonly recordQuestion: (input: {
    readonly effect: QuestionEffect;
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

  /** OutboxRecoveryEffect — retry/abandon failed durable outbox rows. */
  readonly recoverOutbox: (input: {
    readonly effect: OutboxRecoveryEffect;
    readonly processorId: string;
    readonly runId: RunId;
  }) => Promise<boolean>;

  /** QuarantineRecoveryEffect — reset a quarantined processor trigger.
   *
   * Returns false when no current quarantine row matched the effect's
   * generation fields — routing then emits
   * `quarantine-recovery.stale-or-missing` instead of silent success. */
  readonly recoverQuarantine: (input: {
    readonly effect: QuarantineRecoveryEffect;
    readonly processorId: string;
    readonly runId: RunId;
  }) => Promise<boolean>;

  /** RunRecoveryEffect — mark a stuck running ledger row failed. */
  readonly recoverRun: (input: {
    readonly effect: RunRecoveryEffect;
    readonly processorId: string;
    readonly runId: RunId;
  }) => Promise<boolean>;

  /** ViewEffect — captured for return to the view-phase caller. */
  readonly captureView: (input: {
    readonly effect: ViewEffect;
    readonly processorId: string;
    readonly runId: RunId;
  }) => Promise<void>;

  /**
   * Optional garden-propose review sink. A garden-phase PatchEffect under
   * `mode: "propose"` — either emitted directly or produced by an
   * auto→propose capability downgrade — enqueues a durable pending-proposal
   * row via this sink instead of being dropped. Omitted (the v1.0 default
   * before this sink existed, and any sink-less harness such as `dome run`)
   * → the legacy behavior: the patch is surfaced via an info diagnostic and
   * dropped (`garden.patch-propose-review-unavailable`).
   *
   * `effect` is the propose-mode patch actually being enqueued — for a
   * downgrade this is the broker's rewritten shape, not the processor's
   * original auto-mode emission. `baseCommit` is the adoption-loop
   * candidate at routing time, captured so the human-side apply path
   * (`dome apply`) can detect staleness against it. Returns the same
   * `{inserted, id}` shape as `enqueuePendingProposal`
   * (`src/proposals/pending-proposals.ts`) so a dedupe-hit re-emission is
   * distinguishable from a fresh row.
   */
  readonly enqueueProposal?: (input: {
    readonly effect: PatchEffect;
    readonly processorId: string;
    readonly extensionId: string;
    readonly runId: RunId;
    readonly baseCommit: CommitOid;
  }) => Promise<{ readonly inserted: boolean; readonly id: number | null }>;
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
 *   - `blocked-for-review` — a PatchEffect the broker allowed but that will
 *                           not be auto-applied. In adoption this is a
 *                           `mode: "propose"` patch; `diagnostics` carries a
 *                           `block` diagnostic that stops adoption. In garden
 *                           this is a `mode: "propose"` patch (or an
 *                           auto→propose downgrade) reached when no
 *                           `enqueueProposal` sink is wired (e.g. the `dome
 *                           run` view harness); `diagnostics` carries an
 *                           `info` `garden.patch-propose-review-unavailable`
 *                           diagnostic that does not halt anything. Nothing
 *                           routed either way.
 *   - `queued-for-spawn`  — a garden-phase auto-mode PatchEffect the broker
 *                           authorized. The patch is not written through the
 *                           patch sink; instead the garden orchestrator reads
 *                           `appliedEffect` and spawns a sub-Proposal from it.
 *                           `diagnostics` is empty.
 *   - `queued-for-review` — a garden-phase `mode: "propose"` PatchEffect (or
 *                           an auto→propose downgrade rewrite) the broker
 *                           allowed AND the wired `enqueueProposal` sink
 *                           accepted into `proposals.db` for human review.
 *                           `diagnostics` carries an info
 *                           `garden.patch-proposed` diagnostic naming the
 *                           enqueued proposal id, plus the
 *                           `capability-downgrade-surprise` warning when this
 *                           came from a downgrade. `appliedEffect` carries
 *                           the enqueued (possibly rewritten) patch.
 *
 * `appliedEffect` is the effect that was authorized and routed onward — to a
 * sink (`applied`, `downgraded`), to the spawn queue (`queued-for-spawn`), or
 * to the proposals store (`queued-for-review`). It is `null` when nothing was
 * routed: `denied`, `rejected-by-phase`, and `blocked-for-review`.
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
    | "blocked-for-review"
    | "queued-for-spawn"
    | "queued-for-review";
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
    resolveFacts: async () => undefined,
    resolveQuestions: async () => undefined,
    recordFact: async () => undefined,
    recordSearchDocument: async () => undefined,
    recordQuestion: async () => undefined,
    dispatchExternal: async () => undefined,
    recoverOutbox: async () => true,
    recoverQuarantine: async () => true,
    recoverRun: async () => true,
    captureView: async () => undefined,
  };
}

// ----- applyEffect ----------------------------------------------------------

/**
 * The generic effect applier route. Routes one Effect through phase
 * compatibility + capability enforcement + the matching sink. Garden
 * PatchEffects are routed by `garden-patch-dispatch.ts` because they spawn
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
   * The processor's owning extension/bundle id. Threaded through so a
   * garden-phase `mode: "propose"` PatchEffect (or an auto→propose
   * downgrade) can stamp `pending_proposals.extension_id` when the
   * `enqueueProposal` sink is wired — see `ApplyEffectSinks.enqueueProposal`.
   * Every other effect kind and phase ignores this field; callers that never
   * route garden PatchEffects through this router (adoption, view) may omit
   * it.
   */
  readonly extensionId?: string;
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
      ...capabilityUseField(
        opts.effect,
        "denied",
        verdict.deniedCapability,
      ),
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
  const routed: Effect = demoteGardenBlockSeverity(
    verdict.kind === "downgrade" ? verdict.rewrittenEffect : opts.effect,
    opts.phase,
  );
  const verdictDiagnostics: ReadonlyArray<DiagnosticEffect> =
    verdict.kind === "downgrade"
      ? Object.freeze([verdict.diagnostic])
      : EMPTY_DIAGNOSTICS;

  // Garden-phase PatchEffects do not write through the patch sink. The broker
  // decision is shared with adoption (deny handled above); only the post-broker
  // routing differs: an authorized auto-mode patch is queued for the garden
  // orchestrator to spawn as a sub-Proposal — it reads the patch off
  // `appliedEffect`. A downgraded patch or a propose-mode patch enqueues a
  // pending-proposal row when `enqueueProposal` is wired; without that sink,
  // it is surfaced and dropped instead.
  if (opts.phase === "garden" && opts.effect.kind === "patch") {
    if (verdict.kind === "downgrade") {
      if (opts.sinks.enqueueProposal !== undefined) {
        // `routed` is the broker's auto→propose rewrite —
        // `demoteGardenBlockSeverity` is a no-op for PatchEffects, so it is
        // safe to enqueue verbatim.
        const proposePatch = routed as PatchEffect;
        const queued = await queueGardenProposal({
          sinks: opts.sinks,
          enqueueProposal: opts.sinks.enqueueProposal,
          originalEffect: opts.effect,
          patch: proposePatch,
          processorId: opts.processorId,
          extensionId: opts.extensionId,
          runId: opts.runId,
          baseCommit: opts.candidate,
          proposalId: opts.proposalId,
          extraDiagnostics: verdictDiagnostics,
          capabilityOutcome: "downgraded",
        });
        return queued;
      }
      const downgraded = frozen({
        outcome: "downgraded",
        appliedEffect: null,
        diagnostics: verdictDiagnostics,
        ...capabilityUseField(opts.effect, "downgraded"),
      });
      await recordDiagnosticsViaSink({
        sinks: opts.sinks,
        diagnostics: downgraded.diagnostics,
        processorId: opts.processorId,
        proposalId: opts.proposalId,
        runId: opts.runId,
      });
      return downgraded;
    }
    if (routed.kind === "patch" && routed.mode === "propose") {
      if (opts.sinks.enqueueProposal !== undefined) {
        const queued = await queueGardenProposal({
          sinks: opts.sinks,
          enqueueProposal: opts.sinks.enqueueProposal,
          originalEffect: opts.effect,
          patch: routed,
          processorId: opts.processorId,
          extensionId: opts.extensionId,
          runId: opts.runId,
          baseCommit: opts.candidate,
          proposalId: opts.proposalId,
          extraDiagnostics: EMPTY_DIAGNOSTICS,
          capabilityOutcome: "allowed",
        });
        return queued;
      }
      const reviewDiagnostic = diagnosticEffect({
        severity: "info",
        code: "garden.patch-propose-review-unavailable",
        message:
          `Garden PatchEffect from ${opts.processorId} requested review, ` +
          `but the garden propose review surface is not wired in v1.0; ` +
          `patch dropped: ${routed.reason}`,
        sourceRefs: routed.sourceRefs,
      });
      const blocked = frozen({
        outcome: "blocked-for-review",
        appliedEffect: null,
        diagnostics: Object.freeze([reviewDiagnostic]),
        ...capabilityUseField(opts.effect, "allowed"),
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
    // verdict is `allow` and mode is `auto` here (deny/downgrade/propose all
    // returned above), so `routed` is the original patch unchanged — it is the
    // authorized PatchEffect the orchestrator spawns.
    return frozen({
      outcome: "queued-for-spawn",
      appliedEffect: routed,
      diagnostics: EMPTY_DIAGNOSTICS,
      ...capabilityUseField(opts.effect, "allowed"),
    });
  }

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
    diagnostics: Object.freeze([
      ...verdictDiagnostics,
      ...sinkResult.diagnostics,
    ]),
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
  override?: DeniedCapability,
): { capabilityUse?: EffectCapabilityUse } {
  if (override !== undefined) {
    return {
      capabilityUse: Object.freeze({
        capability: override.capability,
        resource: override.resource,
        outcome,
      }),
    };
  }
  const capabilityUse = capabilityUseForEffect(effect, outcome);
  return capabilityUse === null ? {} : { capabilityUse };
}

/**
 * Shared implementation for both `queued-for-review` routes — a plain
 * garden-phase propose-mode PatchEffect, and an auto→propose downgrade
 * rewrite. Calls the (already narrowed-non-undefined) `enqueueProposal`
 * sink, builds the `garden.patch-proposed` info diagnostic naming the
 * enqueued row, persists diagnostics via `recordDiagnosticsViaSink`, and
 * returns the frozen result. `extraDiagnostics` carries the downgrade
 * warning for the downgrade route (empty for the plain propose route).
 * `capabilityOutcome` mirrors the sink-less routes' choice: `"downgraded"`
 * for the auto→propose path (ledgered against the original `patch.auto`
 * capability per the outcome doc on `ApplyEffectResult`), `"allowed"` for
 * the plain propose path.
 */
async function queueGardenProposal(opts: {
  readonly sinks: ApplyEffectSinks;
  readonly enqueueProposal: NonNullable<ApplyEffectSinks["enqueueProposal"]>;
  readonly originalEffect: Effect;
  readonly patch: PatchEffect;
  readonly processorId: string;
  readonly extensionId: string | undefined;
  readonly runId: RunId;
  readonly baseCommit: CommitOid;
  readonly proposalId: string | null;
  readonly extraDiagnostics: ReadonlyArray<DiagnosticEffect>;
  readonly capabilityOutcome: "allowed" | "downgraded";
}): Promise<ApplyEffectResult> {
  const enqueueResult = await opts.enqueueProposal({
    effect: opts.patch,
    processorId: opts.processorId,
    extensionId: opts.extensionId ?? "",
    runId: opts.runId,
    baseCommit: opts.baseCommit,
  });
  const proposedDiagnostic = gardenPatchProposedDiagnostic({
    processorId: opts.processorId,
    proposalRowId: enqueueResult.id,
    patch: opts.patch,
  });
  const queued = frozen({
    outcome: "queued-for-review",
    appliedEffect: opts.patch,
    diagnostics: Object.freeze([...opts.extraDiagnostics, proposedDiagnostic]),
    ...capabilityUseField(opts.originalEffect, opts.capabilityOutcome),
  });
  await recordDiagnosticsViaSink({
    sinks: opts.sinks,
    diagnostics: queued.diagnostics,
    processorId: opts.processorId,
    proposalId: opts.proposalId,
    runId: opts.runId,
  });
  return queued;
}

/**
 * The info diagnostic recorded whenever a garden propose-mode (or downgrade-
 * rewritten) patch lands in `proposals.db`. Names the enqueued row so `dome
 * proposals`/`dome apply` are directly actionable from `dome check` /
 * `dome inspect diagnostics` output.
 */
function gardenPatchProposedDiagnostic(opts: {
  readonly processorId: string;
  readonly proposalRowId: number | null;
  readonly patch: PatchEffect;
}): DiagnosticEffect {
  const proposalLabel =
    opts.proposalRowId === null
      ? "a proposal"
      : `proposal P${opts.proposalRowId}`;
  return diagnosticEffect({
    severity: "info",
    code: "garden.patch-proposed",
    message:
      `Garden PatchEffect from ${opts.processorId} queued ${proposalLabel} ` +
      `for review — \`dome proposals\`: ${opts.patch.reason}`,
    sourceRefs: opts.patch.sourceRefs,
  });
}

/**
 * Garden runs after adoption, so a `block`-severity diagnostic cannot block
 * anything — but a persisted `block` row would make every surface that
 * treats `severity = "block"` as "adoption is blocked" report a blocker no
 * sync can ever clear. Per docs/wiki/specs/effects.md §DiagnosticEffect and
 * docs/wiki/matrices/effect-router-targets.md, garden `block` is recorded
 * as `error`.
 */
function demoteGardenBlockSeverity(
  effect: Effect,
  phase: ProcessorPhase,
): Effect {
  if (
    phase !== "garden" ||
    effect.kind !== "diagnostic" ||
    effect.severity !== "block"
  ) {
    return effect;
  }
  return diagnosticEffect({
    severity: "error",
    code: effect.code,
    message: effect.message,
    sourceRefs: effect.sourceRefs,
  });
}

// ----- phase compatibility --------------------------------------------------

/**
 * Per docs/wiki/matrices/effect-router-targets.md, the (kind, phase) cells
 * marked "Rejected: phase-mismatch":
 *
 *   - adoption: ExternalActionEffect, OutboxRecoveryEffect,
 *               QuarantineRecoveryEffect, RunRecoveryEffect, ViewEffect
 *   - garden:   ViewEffect
 *   - view:     PatchEffect, DiagnosticEffect (severity: "block"),
 *               FactEffect, SearchDocumentEffect, QuestionEffect,
 *               ExternalActionEffect, OutboxRecoveryEffect,
 *               QuarantineRecoveryEffect, RunRecoveryEffect
 *
 * Every other (kind, phase) pair is routed normally.
 */
function isPhaseCompatible(effect: Effect, phase: ProcessorPhase): boolean {
  if (!EFFECT_PHASE_COMPATIBILITY[effect.kind][phase]) {
    return false;
  }
  if (effect.kind === "diagnostic" && phase === "view") {
    return effect.severity !== "block";
  }
  return true;
}

function rejectedByPhase(
  effect: Effect,
  phase: ProcessorPhase,
): ApplyEffectResult {
  const message = `Processor in phase '${phase}' cannot emit effect of kind '${effect.kind}'`;
  return frozen({
    outcome: "rejected-by-phase",
    appliedEffect: null,
    diagnostics: Object.freeze([
      diagnosticEffect({
        severity: "error",
        code: "phase-mismatch",
        message,
        sourceRefs: [],
      }),
    ]),
  });
}

// ----- routing dispatch -----------------------------------------------------

/**
 * Exhaustive `switch` on `Effect.kind` — the structural fence behind
 * [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]. The `never`-typed
 * `_exhaustive` makes adding an Effect kind here a compile error
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
): Promise<{
  readonly newCandidate: CommitOid | null;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
}> {
  switch (effect.kind) {
    case "patch": {
      const newCandidate = await opts.sinks.applyPatch({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
        candidate: opts.candidate,
      });
      return { newCandidate, diagnostics: EMPTY_DIAGNOSTICS };
    }
    case "diagnostic":
      await opts.sinks.recordDiagnostic({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
        proposalId: opts.proposalId,
      });
      return EMPTY_SINK_RESULT;
    case "fact":
      await opts.sinks.recordFact({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
      });
      return EMPTY_SINK_RESULT;
    case "search-document":
      await opts.sinks.recordSearchDocument({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
      });
      return EMPTY_SINK_RESULT;
    case "question":
      await opts.sinks.recordQuestion({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
      });
      return EMPTY_SINK_RESULT;
    case "external":
      await opts.sinks.dispatchExternal({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
      });
      return EMPTY_SINK_RESULT;
    case "outbox-recovery":
      if (
        !(await opts.sinks.recoverOutbox({
          effect,
          processorId: opts.processorId,
          runId: opts.runId,
        }))
      ) {
        return staleRecoveryResult({
          code: "outbox-recovery.stale-or-missing",
          message:
            `OutboxRecoveryEffect did not change row ${effect.idempotencyKey}: ` +
            "the row is no longer failed, no longer matches the question generation, or does not exist.",
          sourceRefs: effect.sourceRefs,
        });
      }
      return EMPTY_SINK_RESULT;
    case "quarantine-recovery":
      if (
        !(await opts.sinks.recoverQuarantine({
          effect,
          processorId: opts.processorId,
          runId: opts.runId,
        }))
      ) {
        return staleRecoveryResult({
          code: "quarantine-recovery.stale-or-missing",
          message:
            `QuarantineRecoveryEffect did not clear quarantine ${effect.quarantineId} ` +
            `for ${effect.processorId}@${effect.processorVersion} (${effect.phase}): ` +
            "the quarantine no longer matches the question generation or does not exist.",
          sourceRefs: effect.sourceRefs,
        });
      }
      return EMPTY_SINK_RESULT;
    case "run-recovery":
      if (
        !(await opts.sinks.recoverRun({
          effect,
          processorId: opts.processorId,
          runId: opts.runId,
        }))
      ) {
        return staleRecoveryResult({
          code: "run-recovery.stale-or-missing",
          message:
            `RunRecoveryEffect did not change run ${effect.runId}: ` +
            "the row is no longer running, no longer matches the question generation, or does not exist.",
          sourceRefs: effect.sourceRefs,
        });
      }
      return EMPTY_SINK_RESULT;
    case "view":
      await opts.sinks.captureView({
        effect,
        processorId: opts.processorId,
        runId: opts.runId,
      });
      return EMPTY_SINK_RESULT;
  }
  // Exhaustive switch — TS verifies via the `never` exhaustiveness check.
  // Adding an Effect kind here is a compile error until every branch
  // above is updated.
  const _exhaustive: never = effect;
  return _exhaustive;
}

// ----- frozen-result helpers ------------------------------------------------

const EMPTY_DIAGNOSTICS: ReadonlyArray<DiagnosticEffect> = Object.freeze([]);
const EMPTY_SINK_RESULT: {
  readonly newCandidate: CommitOid | null;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
} = Object.freeze({
  newCandidate: null,
  diagnostics: EMPTY_DIAGNOSTICS,
});

/**
 * Freeze the result object so misbehaving callers (or downstream layers that
 * persist results to the run ledger) cannot mutate the verdict after the
 * fact. The diagnostics array is frozen at construction in every call site.
 */
function frozen(result: ApplyEffectResult): ApplyEffectResult {
  return Object.freeze(result);
}

// The three operational-recovery effects share one stale-answer contract:
// the sink returns false when no current row matched the effect's
// generation fields, and routing surfaces that as a warning instead of
// silent success. (See docs/wiki/specs/effects.md — recovery effects.)
function staleRecoveryResult(opts: {
  readonly code: "outbox-recovery.stale-or-missing" | "quarantine-recovery.stale-or-missing" | "run-recovery.stale-or-missing";
  readonly message: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
}): {
  readonly newCandidate: CommitOid | null;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
} {
  return Object.freeze({
    newCandidate: null,
    diagnostics: Object.freeze([
      diagnosticEffect({
        severity: "warning",
        code: opts.code,
        message: opts.message,
        sourceRefs: opts.sourceRefs,
      }),
    ]),
  });
}
