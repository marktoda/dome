// projection-sinks: assembles the `ApplyEffectSinks` shape against
// the projection database, the outbox database, and engine-layer injections
// (`applyPatch`, `captureView`, `recoverQuarantine`, `recoverRun`). This is the
// Phase 4 wiring layer
// that replaces `noopSinks()` from `src/engine/core/apply-effect.ts` once the
// projection + outbox stores are open.
//
// Nine sinks are owned here (delegating to the per-table accessors):
//
//   - recordDiagnostic → src/projections/diagnostics.ts: insertDiagnostic
//   - resolveFacts     → src/projections/facts.ts:       resolveStalePageFacts
//   - recordFact       → src/projections/facts.ts:       insertFact
//   - recordSearchDocument → src/projections/search.ts:  applySearchDocumentEffect
//   - recordQuestion   → src/projections/questions.ts:   insertQuestion
//   - resolveQuestions → src/projections/questions.ts:   resolveStaleQuestions
//   - dispatchExternal → src/outbox/dispatch.ts:         dispatchExternalEffect
//   - recoverOutbox    → src/outbox/dispatch.ts:         recoverFailedOutboxRow
//   - enqueueProposal  → src/proposals/pending-proposals.ts: enqueuePendingProposal
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
// House-style notes (matches src/projections/facts.ts, src/engine/core/apply-effect.ts):
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
//   - No git. `enqueueProposal` is the one sink that reads the filesystem
//     directly (a synchronous `readFileSync` per changed path, to capture
//     `baseContents` at enqueue time) — every other sink here is pure SQL
//     against the injected DB handles; ExternalActionEffects still delegate
//     to the supplied outbox handlers rather than touching the network here.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ApplyEffectSinks } from "../engine/core/apply-effect";
import type { CommitOid } from "../core/source-ref";
import type { ProjectionDb } from "./db";
import type { OutboxDb } from "../outbox/db";
import type { ProposalsDb } from "../proposals/db";

import { insertDiagnostic, resolveStaleDiagnostics } from "./diagnostics";
import { insertFact, resolveStalePageFacts } from "./facts";
import { applySearchDocumentEffect } from "./search";
import { insertQuestion, resolveStaleQuestions } from "./questions";
import { enqueuePendingProposal } from "../proposals/pending-proposals";
import {
  dispatchExternalEffect,
  recoverFailedOutboxRow,
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
   * Optional host-level mutex for projection.db writes. Runtime hosts pass the
   * shared projection write lock so rebuild/reset cannot interleave with
   * incremental projection rows. Tests and isolated in-memory sinks may omit it.
   */
  readonly projectionWriteLock?: <T>(fn: () => Promise<T>) => Promise<T>;
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
   * Per-attempt bound for external handlers, threaded from
   * `engine.external_handler_timeout_ms`. Absent → the dispatch layer's
   * 30s default.
   */
  readonly externalHandlerTimeoutMs?: number;
  /**
   * Injected by the engine layer. Quarantine state is operational processor
   * execution state, not projection or outbox state.
   */
  readonly recoverQuarantine: ApplyEffectSinks["recoverQuarantine"];
  /**
   * Injected by the engine layer. Run recovery mutates the run ledger.
   */
  readonly recoverRun: ApplyEffectSinks["recoverRun"];
  /**
   * Fired whenever a sink changed the open-question set: `recordQuestion`
   * inserted or refreshed a row (a `"skipped-answered"` re-emit does NOT
   * fire), or `resolveQuestions` deleted at least one stale row. The host
   * wires this to its tick-scoped `questions.changed` flag; the tick epilogue
   * dispatches subscribers once (processors.md §"Triggers and signals").
   * Omitted → no signal channel (tests, isolated sinks).
   */
  readonly onQuestionsChanged?: () => void;
  /**
   * Fired whenever a `dispatchExternal` attempt terminally failed an outbox
   * row (the outbox dispatcher's `recordFailedAttempt` terminal branch). The
   * host wires this to its tick-scoped `outbox.changed` flag; the tick epilogue
   * dispatches subscribers once (processors.md §"Triggers and signals").
   * Omitted → no signal channel (tests, isolated sinks).
   */
  readonly onOutboxChanged?: () => void;
  /**
   * The open proposals.db handle. When present (together with `vaultPath`),
   * the returned sinks object includes `enqueueProposal`: garden-phase
   * propose-mode PatchEffects (plain, or an auto→propose downgrade rewrite)
   * land in `pending_proposals` instead of being surfaced and dropped (see
   * `apply-effect.ts`'s garden patch branch). Omitted → `enqueueProposal` is
   * not included in the returned object, so `applyEffect` falls back to the
   * legacy `garden.patch-propose-review-unavailable` drop.
   */
  readonly proposalsDb?: ProposalsDb;
  /**
   * Absolute filesystem path to the vault root. Used only by
   * `enqueueProposal` to resolve each changed path against the working tree
   * and read its CURRENT content into `baseContents` (the human-side
   * `dome apply` staleness check compares against this later). Required
   * alongside `proposalsDb` for `enqueueProposal` to be included.
   */
  readonly vaultPath?: string;
  /**
   * Fired whenever `enqueueProposal` actually inserted a new row (a dedupe-
   * hit re-enqueue does not fire it). The host wires this to its tick-scoped
   * `proposals.changed` flag; the tick epilogue dispatches subscribers once
   * (processors.md §"Triggers and signals"). Omitted → no signal channel
   * (tests, isolated sinks).
   */
  readonly onProposalsChanged?: () => void;
};

// ----- buildSqliteSinks -----------------------------------------------------

/**
 * Assemble the `ApplyEffectSinks` object the engine calls while routing
 * effects and maintaining projection rows. The projection/outbox sinks
 * delegate to the per-table accessors + the outbox dispatcher; four are
 * pass-through injections from the engine layer (`applyPatch`, `captureView`,
 * `recoverQuarantine`, `recoverRun`).
 *
 * The returned object is `Object.freeze`'d so a misbehaving caller cannot
 * swap a sink out mid-run (e.g., a downstream layer attempting to monkey-
 * patch `recordFact`). Sinks throw on SQLite-level failure; the contract
 * with `applyEffect` is that errors propagate.
 */
export function buildSqliteSinks(opts: BuildSqliteSinksOpts): ApplyEffectSinks {
  const projectionWrite = <T>(fn: () => Promise<T>): Promise<T> =>
    opts.projectionWriteLock === undefined ? fn() : opts.projectionWriteLock(fn);

  return Object.freeze<ApplyEffectSinks>({
    applyPatch: opts.applyPatch,
    captureView: opts.captureView,

    recordDiagnostic: async ({ effect, processorId, runId, proposalId }) => {
      await projectionWrite(async () => {
        insertDiagnostic(opts.projectionDb, {
          effect,
          processorId,
          proposalId,
          adoptedCommit: opts.adoptedCommit,
          ...(runId !== undefined ? { runId } : {}),
        });
      });
    },

    resolveDiagnostics: async ({
      processorId,
      inspectedPaths,
      emittedDiagnostics,
    }) => {
      await projectionWrite(async () => {
        resolveStaleDiagnostics(opts.projectionDb, {
          processorId,
          inspectedPaths,
          emittedDiagnostics,
        });
      });
    },

    resolveFacts: async ({ processorId, runId, inspectedPaths }) => {
      await projectionWrite(async () => {
        resolveStalePageFacts(opts.projectionDb, {
          processorId,
          inspectedPaths,
          runId,
        });
      });
    },

    resolveQuestions: async ({
      processorId,
      inspectedPaths,
      emittedQuestions,
    }) => {
      await projectionWrite(async () => {
        const deleted = resolveStaleQuestions(opts.projectionDb, {
          processorId,
          inspectedPaths,
          emittedQuestions,
        });
        if (deleted > 0) opts.onQuestionsChanged?.();
      });
    },

    recordFact: async ({ effect, processorId, runId }) => {
      await projectionWrite(async () => {
        insertFact(opts.projectionDb, {
          effect,
          processorId,
          runId,
          adoptedCommit: opts.adoptedCommit,
        });
      });
    },

    recordSearchDocument: async ({ effect }) => {
      await projectionWrite(async () => {
        applySearchDocumentEffect(opts.projectionDb, {
          effect,
          adoptedCommit: opts.adoptedCommit,
        });
      });
    },

    recordQuestion: async ({ effect, processorId, runId }) => {
      await projectionWrite(async () => {
        const result = insertQuestion(opts.projectionDb, {
          effect,
          processorId,
          runId,
          adoptedCommit: opts.adoptedCommit,
        });
        // "skipped-answered" leaves the open-question set untouched — no signal.
        if (result !== "skipped-answered") opts.onQuestionsChanged?.();
      });
    },

    dispatchExternal: async ({ effect, runId }) => {
      await dispatchExternalEffect(opts.outboxDb, {
        effect,
        runId,
        handlers: opts.externalHandlers ?? EMPTY_EXTERNAL_HANDLERS,
        ...(opts.externalHandlerTimeoutMs !== undefined
          ? { handlerTimeoutMs: opts.externalHandlerTimeoutMs }
          : {}),
        ...(opts.onOutboxChanged !== undefined
          ? { onOutboxChanged: opts.onOutboxChanged }
          : {}),
      });
    },

    recoverOutbox: async ({ effect }) =>
      recoverFailedOutboxRow(opts.outboxDb, {
        idempotencyKey: effect.idempotencyKey,
        action: effect.action,
        ...(effect.failureToken !== undefined
          ? { failureToken: effect.failureToken }
          : {}),
      }),

    recoverQuarantine: opts.recoverQuarantine,
    recoverRun: opts.recoverRun,

    ...(opts.proposalsDb !== undefined && opts.vaultPath !== undefined
      ? {
          enqueueProposal: async ({
            effect,
            processorId,
            extensionId,
            runId,
            baseCommit,
          }) => {
            const proposalsDb = opts.proposalsDb!;
            const vaultPath = opts.vaultPath!;
            const baseContents: Record<string, string | null> = {};
            for (const change of effect.changes) {
              baseContents[change.path] = readWorkingFileOrNull(
                join(vaultPath, change.path),
              );
            }
            const result = enqueuePendingProposal(proposalsDb, {
              processorId,
              extensionId,
              runId,
              reason: effect.reason,
              changes: effect.changes,
              sourceRefs: effect.sourceRefs,
              baseCommit,
              baseContents: Object.freeze(baseContents),
              createdAt: new Date().toISOString(),
            });
            if (result.inserted) opts.onProposalsChanged?.();
            return result;
          },
        }
      : {}),
  });
}

/**
 * Read a working-tree file's full content for `enqueueProposal`'s
 * `baseContents` capture. `null` when the file doesn't exist yet (a patch
 * that creates a new path) — not an error condition. Any other read failure
 * (permissions, I/O error) propagates per this file's no-try/catch contract.
 */
function readWorkingFileOrNull(absolutePath: string): string | null {
  try {
    return readFileSync(absolutePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
