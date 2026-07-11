// engine/operational/operational-work: one pump for non-adoption engine work.
//
// Adoption owns trusted-state convergence. This module owns the adjacent
// operational queues that should make progress once trusted state is stable:
// due schedule triggers and pending outbox rows. The outbox drain is bounded
// to rows that were already pending before this pump started, so external
// effects created by scheduler work do not get an immediate same-pump retry
// after a transient failure. Keeping the pump explicit prevents each caller
// (`sync`, `serve`, tests, future close/drain) from inventing its own partial
// lifecycle.

import type { DiagnosticEffect } from "../../core/effect";
import type { AnswersDb } from "../../answers/db";
import type {
  Capability,
  ExtensionConfig,
  OperationalQueryView,
  TreeOid,
} from "../../core/processor";
import type { AdoptionResult, Proposal } from "../../core/proposal";
import type { CommitOid } from "../../core/source-ref";
import type { LedgerDb } from "../../ledger/db";
import {
  dispatchPendingOutbox,
  type ExternalDispatchResult,
  type ExternalHandlerRegistry,
} from "../../outbox/dispatch";
import type { OutboxDb } from "../../outbox/db";
import type { ProjectionDb } from "../../projections/db";
import type { ProposalsDb } from "../../proposals/db";
import type { ExecutionPolicyCap } from "../../processors/execution-policy";
import type { ProcessorExecutionState } from "../../processors/execution-state";
import type { ProcessorRegistry } from "../../processors/registry";
import type { ModelProvider, ModelStepProvider } from "../core/model-invoke";
import type { ApplyEffectSinks } from "../core/apply-effect";
import type { ApplyPatchInput } from "../core/apply-patch";
import {
  expireOrphanProposals,
  type ProposalExpiryResult,
} from "./proposal-expiry";
import {
  expireOrphanSubjectQuestions,
  type QuestionExpiryResult,
} from "./question-expiry";
import { runScheduler, type SchedulerResult } from "./scheduler";
import type { EngineVault } from "../core/vault-shape";

export type OperationalWorkResult = {
  readonly scheduler: SchedulerResult;
  readonly outbox: ReadonlyArray<ExternalDispatchResult>;
  /** Compatibility counter. Generic metadata-driven auto-resolution is retired. */
  readonly questionAutoResolution: RetiredQuestionAutoResolutionResult;
  /** Subject-liveness expiry: OPEN questions released this tick + their
   * diagnostics (also folded into `diagnostics` below). */
  readonly questionExpiry: QuestionExpiryResult;
  /** Subject-liveness expiry: PENDING proposals auto-rejected this tick +
   * their diagnostics (also folded into `diagnostics` below). */
  readonly proposalExpiry: ProposalExpiryResult;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
};

export async function runOperationalWork(opts: {
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly registry: ProcessorRegistry;
  readonly projection: ProjectionDb;
  readonly answers?: AnswersDb;
  /** The pending-proposals store; absent → proposal expiry is skipped (parity with `answers` gating question expiry). */
  readonly proposals?: ProposalsDb;
  readonly outbox: OutboxDb;
  readonly sinks: ApplyEffectSinks;
  readonly resolveTree: (commit: CommitOid) => Promise<TreeOid>;
  readonly now: () => Date;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly extensionConfigFor?: (extensionId: string) => ExtensionConfig;
  readonly externalHandlers: ExternalHandlerRegistry;
  /**
   * Per-attempt bound for external handlers, threaded from
   * `engine.external_handler_timeout_ms`. Absent → the dispatch layer's
   * 30s default.
   */
  readonly externalHandlerTimeoutMs?: number;
  /**
   * Fired once after subject-liveness expiry when it expired anything. The
   * expiry transition bypasses `recordQuestion`, so the host's tick-scoped
   * `questions.changed` flag must be set here explicitly.
   */
  readonly onQuestionsChanged?: () => void;
  /**
   * Fired once after the proposal subject-liveness expiry pump when it
   * expired anything — the pending-proposals list shrank outside the
   * `enqueueProposal` sink, so the host's tick-scoped `proposals.changed`
   * flag must be set here explicitly (same contract as `onQuestionsChanged`
   * above). The host wires this to `markProposalsChanged`.
   */
  readonly onProposalsChanged?: () => void;
  /**
   * Extension ids configured but DISABLED, threaded to subject-liveness
   * question AND proposal expiry: their processors are absent from the
   * registry by design and must NOT have their questions/proposals expired
   * (the quarantine-GC posture — see `isKnownProcessorFor` in
   * src/engine/host/vault-runtime.ts). Absent → treated as empty (registry
   * fully authoritative).
   */
  readonly disabledExtensionIds?: ReadonlyArray<string>;
  /**
   * Fired when the outbox drain terminally failed a row (either
   * `recoverExpiredDispatching`'s terminal branch or a `dispatchPendingOutbox`
   * attempt exhausting its retries). The host wires this to its tick-scoped
   * `outbox.changed` flag; the tick epilogue dispatches subscribers once.
   */
  readonly onOutboxChanged?: () => void;
  readonly operational?: OperationalQueryView;
  readonly ledger: LedgerDb;
  readonly executionState?: ProcessorExecutionState;
  /** NEEDS_ARE_LOUD session dedup set, threaded to dispatchGardenRun. */
  readonly needUnmetSeen?: Set<string>;
  readonly executionCap?: ExecutionPolicyCap;
  readonly modelProvider?: ModelProvider;
  readonly modelStepProvider?: ModelStepProvider;
  readonly adoptSubProposal?: (
    proposal: Proposal,
    cascadeDepth: number,
  ) => Promise<AdoptionResult>;
  readonly currentAdopted?: () => CommitOid;
  readonly signal?: AbortSignal;
  readonly applyGardenPatchToCandidate?: (
    opts: ApplyPatchInput,
  ) => Promise<CommitOid | null>;
}): Promise<OperationalWorkResult> {
  const outboxNow = opts.now();
  const outboxDrainCutoff = outboxNow;

  const scheduler = await runScheduler({
    vault: opts.vault,
    adopted: opts.adopted,
    registry: opts.registry,
    projection: opts.projection,
    sinks: opts.sinks,
    resolveTree: opts.resolveTree,
    now: opts.now,
    resolveGrants: opts.resolveGrants,
    extensionIdFor: opts.extensionIdFor,
    ...(opts.extensionConfigFor !== undefined
      ? { extensionConfigFor: opts.extensionConfigFor }
      : {}),
    ledger: opts.ledger,
    ...(opts.executionState !== undefined
      ? { executionState: opts.executionState }
      : {}),
    ...(opts.needUnmetSeen !== undefined
      ? { needUnmetSeen: opts.needUnmetSeen }
      : {}),
    ...(opts.executionCap !== undefined
      ? { executionCap: opts.executionCap }
      : {}),
    ...(opts.modelProvider !== undefined
      ? { modelProvider: opts.modelProvider }
      : {}),
    ...(opts.modelStepProvider !== undefined
      ? { modelStepProvider: opts.modelStepProvider }
      : {}),
    ...(opts.operational !== undefined ? { operational: opts.operational } : {}),
    ...(opts.adoptSubProposal !== undefined
      ? { adoptSubProposal: opts.adoptSubProposal }
      : {}),
    ...(opts.currentAdopted !== undefined
      ? { currentAdopted: opts.currentAdopted }
      : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.applyGardenPatchToCandidate !== undefined
      ? { applyGardenPatchToCandidate: opts.applyGardenPatchToCandidate }
      : {}),
  });

  const outbox = await dispatchPendingOutbox(opts.outbox, {
    handlers: opts.externalHandlers,
    enqueuedBefore: outboxDrainCutoff,
    now: outboxNow,
    ...(opts.externalHandlerTimeoutMs !== undefined
      ? { handlerTimeoutMs: opts.externalHandlerTimeoutMs }
      : {}),
    ...(opts.onOutboxChanged !== undefined
      ? { onOutboxChanged: opts.onOutboxChanged }
      : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  const questionAutoResolution = emptyQuestionAutoResolution();

  const questionExpiry =
    opts.answers === undefined
      ? emptyQuestionExpiry()
      : await expireOrphanSubjectQuestions({
          registry: opts.registry,
          disabledExtensionIds: opts.disabledExtensionIds ?? [],
          questions: opts.projection,
          answers: opts.answers,
          recordDiagnostic: opts.sinks.recordDiagnostic,
          now: opts.now,
        });
  // Expiry answers bypass the `recordQuestion` sink the same way durable
  // auto-answers do; raise the tick-scoped `questions.changed` flag so
  // subscribers (e.g. the daily To-decide compiler) refresh this tick.
  if (questionExpiry.expired > 0) opts.onQuestionsChanged?.();

  const proposalExpiry =
    opts.proposals === undefined
      ? emptyProposalExpiry()
      : await expireOrphanProposals({
          registry: opts.registry,
          disabledExtensionIds: opts.disabledExtensionIds ?? [],
          proposals: opts.proposals,
          recordDiagnostic: opts.sinks.recordDiagnostic,
          now: opts.now,
        });
  // Same bypass as question expiry: proposal decisions land outside the
  // `enqueueProposal` sink, so the tick-scoped `proposals.changed` flag must
  // be raised here explicitly.
  if (proposalExpiry.expired > 0) opts.onProposalsChanged?.();

  return Object.freeze({
    scheduler,
    outbox,
    questionAutoResolution,
    questionExpiry,
    proposalExpiry,
    diagnostics: Object.freeze([
      ...scheduler.diagnostics,
      ...questionAutoResolution.diagnostics,
      ...questionExpiry.diagnostics,
      ...proposalExpiry.diagnostics,
    ]),
  });
}

function emptyQuestionExpiry(): QuestionExpiryResult {
  return Object.freeze({ expired: 0, diagnostics: Object.freeze([]) });
}

function emptyProposalExpiry(): ProposalExpiryResult {
  return Object.freeze({ expired: 0, diagnostics: Object.freeze([]) });
}

type RetiredQuestionAutoResolutionResult = {
  readonly enabled: false;
  readonly considered: 0;
  readonly answered: 0;
  readonly skipped: 0;
  readonly handlerFailed: 0;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
};

function emptyQuestionAutoResolution(): RetiredQuestionAutoResolutionResult {
  return Object.freeze({
    enabled: false,
    considered: 0,
    answered: 0,
    skipped: 0,
    handlerFailed: 0,
    diagnostics: Object.freeze([]),
  });
}
