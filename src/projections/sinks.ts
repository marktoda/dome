// projection-sinks: assembles the `ApplyEffectSinks` shape against
// the projection database, the outbox database, and engine-layer injections
// (`applyPatch`, `captureView`, `recoverQuarantine`, `recoverRun`). This is the
// Phase 4 wiring layer
// that replaces `noopSinks()` from `src/engine/apply-effect.ts` once the
// projection + outbox stores are open.
//
// Eight sinks are owned here (delegating to the per-table accessors):
//
//   - recordDiagnostic → src/projections/diagnostics.ts: insertDiagnostic
//   - resolveFacts     → src/projections/facts.ts:       resolveStalePageFacts
//   - recordFact       → src/projections/facts.ts:       insertFact
//   - recordSearchDocument → src/projections/search.ts:  applySearchDocumentEffect
//   - recordQuestion   → src/projections/questions.ts:   insertQuestion
//   - enqueueJob       → src/projections/jobs.ts:        enqueueJob
//   - dispatchExternal → src/outbox/dispatch.ts:         dispatchExternalEffect
//   - recoverOutbox    → src/outbox/dispatch.ts:         replayFailed / markAbandoned
//
// Four sinks are injected by the caller (engine layer):
//
//   - applyPatch  — patch application is dual-mode per the matrix below
//     (adoption-phase patches mutate the candidate tree; garden-phase patches
//     spawn a new Proposal). Neither is a SQL operation; both are git-tree
//     operations that live in the engine's `adopt.ts`, where the candidate-
//     tree handle exists.
//
//   - captureView — a ViewEffect's destination is the caller (CLI command,
//     MCP request). The view-phase processor returns its rendered output for
//     the engine to relay back to the caller's stdout / stream / response.
//     That delivery surface doesn't live in the projection store.
//
//   - recoverQuarantine — QuarantineRecoveryEffect targets processor
//     execution state, which is owned by the engine runtime rather than
//     the projection/outbox stores.
//
//   - recoverRun — RunRecoveryEffect targets the run ledger, which is owned
//     by the engine runtime rather than the projection/outbox stores.
//
// Normative references:
//   - docs/wiki/matrices/effect-router-targets.md — the (kind, phase) → sink
//     routing matrix this factory satisfies.
//   - docs/wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER.md — the structural
//     fence that pins all Effect mutation to flow through `applyEffect` and
//     its injected `ApplyEffectSinks`.
//   - docs/wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX.md — pins
//     `dispatchExternal` to the outbox dispatcher exclusively.
//
// House-style notes (matches src/projections/facts.ts, src/engine/apply-effect.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - `Object.freeze` on the returned sinks object so misbehaving callers
//     fail loudly at runtime rather than silently swap a sink out from
//     under the engine mid-run.
//   - No try/catch — per the contract in apply-effect.ts §"Errors a sink
//     throws propagate up to the caller — `applyEffect` does not catch."
//     Constraint violations / disk-full / SQLite errors bubble.
//   - Each sink callback uses `async (input) => { ... }` arrow form. In v1
//     the inserts are synchronous SQL calls (Bun's sqlite is sync) wrapped
//     in an async function for structural compatibility with the
//     `Promise<void>` return signature of `ApplyEffectSinks`.
//   - No filesystem and no git. ExternalActionEffects delegate to the
//     supplied outbox handlers, so network-capable behavior is injected at
//     this boundary rather than hidden in processors.

import type { ApplyEffectSinks } from "../engine/apply-effect";
import type { CommitOid } from "../core/source-ref";
import type { ProjectionDb } from "./db";
import type { OutboxDb } from "../outbox/db";

import { insertDiagnostic, resolveStaleDiagnostics } from "./diagnostics";
import { insertFact, resolveStalePageFacts } from "./facts";
import { applySearchDocumentEffect } from "./search";
import { insertQuestion } from "./questions";
import { enqueueJob as enqueueJobRow } from "./jobs";
import {
  dispatchExternalEffect,
  markAbandoned,
  replayFailed,
  type ExternalHandlerRegistry,
} from "../outbox/dispatch";

const EMPTY_EXTERNAL_HANDLERS = Object.freeze({});

// ----- Public types ---------------------------------------------------------

export type BuildSqliteSinksOpts = {
  /** The open projection.db handle. Used by the projection-store sinks. */
  readonly projectionDb: ProjectionDb;
  /** The open outbox.db handle. Used by `dispatchExternal`. */
  readonly outboxDb: OutboxDb;
  /**
   * The commit the current sync run is adopting against. Stamped onto every
   * fact / diagnostic / question row written during this run, per spec
   * §"Tables" (`adopted_commit` column).
   */
  readonly adoptedCommit: CommitOid;
  /**
   * Injected by the engine layer. The view-effect delivery surface (CLI
   * stdout, MCP response, future HTTP stream) doesn't live in the
   * projection store, so the engine wires this in.
   */
  readonly captureView: ApplyEffectSinks["captureView"];
  /**
   * Injected by the engine layer. Patch application is a git-tree
   * operation (mutate candidate tree in adoption phase; spawn new Proposal
   * in garden phase per the matrix); neither is a SQL operation and
   * neither belongs in this factory.
   */
  readonly applyPatch: ApplyEffectSinks["applyPatch"];
  /**
   * Registered handlers for ExternalActionEffect capabilities. When omitted,
   * external effects still go through the outbox, but the row terminally
   * fails with a missing-handler error instead of lingering as pending.
   */
  readonly externalHandlers?: ExternalHandlerRegistry;
  /**
   * Injected by the engine layer. Quarantine state is operational processor
   * execution state, not projection or outbox state.
   */
  readonly recoverQuarantine: ApplyEffectSinks["recoverQuarantine"];
  /**
   * Injected by the engine layer. Run recovery mutates the run ledger.
   */
  readonly recoverRun: ApplyEffectSinks["recoverRun"];
};

// ----- buildSqliteSinks -----------------------------------------------------

/**
 * Assemble the `ApplyEffectSinks` object the engine calls while routing
 * effects and maintaining projection rows. Eight sinks delegate to the
 * per-table projection accessors + the outbox dispatcher; two are
 * pass-through injections from the engine layer (`applyPatch`, `captureView`,
 * `recoverQuarantine`, `recoverRun`).
 *
 * The returned object is `Object.freeze`'d so a misbehaving caller cannot
 * swap a sink out mid-run (e.g., a downstream layer attempting to monkey-
 * patch `recordFact`). Sinks throw on SQLite-level failure; the contract
 * with `applyEffect` is that errors propagate.
 */
export function buildSqliteSinks(opts: BuildSqliteSinksOpts): ApplyEffectSinks {
  return Object.freeze<ApplyEffectSinks>({
    applyPatch: opts.applyPatch,
    captureView: opts.captureView,

    recordDiagnostic: async ({ effect, processorId, proposalId }) => {
      insertDiagnostic(opts.projectionDb, {
        effect,
        processorId,
        proposalId,
        adoptedCommit: opts.adoptedCommit,
      });
    },

    resolveDiagnostics: async ({
      processorId,
      inspectedPaths,
      emittedDiagnostics,
    }) => {
      resolveStaleDiagnostics(opts.projectionDb, {
        processorId,
        inspectedPaths,
        emittedDiagnostics,
      });
    },

    resolveFacts: async ({ processorId, inspectedPaths }) => {
      resolveStalePageFacts(opts.projectionDb, {
        processorId,
        inspectedPaths,
      });
    },

    recordFact: async ({ effect, processorId }) => {
      insertFact(opts.projectionDb, {
        effect,
        processorId,
        adoptedCommit: opts.adoptedCommit,
      });
    },

    recordSearchDocument: async ({ effect }) => {
      applySearchDocumentEffect(opts.projectionDb, {
        effect,
        adoptedCommit: opts.adoptedCommit,
      });
    },

    recordQuestion: async ({ effect, processorId }) => {
      insertQuestion(opts.projectionDb, {
        effect,
        processorId,
        adoptedCommit: opts.adoptedCommit,
      });
    },

    enqueueJob: async ({ effect, processorId }) => {
      enqueueJobRow(opts.projectionDb, {
        effect,
        processorId,
      });
    },

    dispatchExternal: async ({ effect, runId }) => {
      await dispatchExternalEffect(opts.outboxDb, {
        effect,
        runId,
        handlers: opts.externalHandlers ?? EMPTY_EXTERNAL_HANDLERS,
      });
    },

    recoverOutbox: async ({ effect }) => {
      if (effect.action === "retry") {
        replayFailed(opts.outboxDb, effect.idempotencyKey);
      } else {
        markAbandoned(opts.outboxDb, effect.idempotencyKey);
      }
    },

    recoverQuarantine: opts.recoverQuarantine,
    recoverRun: opts.recoverRun,
  });
}
