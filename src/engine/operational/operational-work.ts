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
import type { ExecutionPolicyCap } from "../../processors/execution-policy";
import type { ProcessorExecutionState } from "../../processors/execution-state";
import type { ProcessorRegistry } from "../../processors/registry";
import type { ModelProvider, ModelStepProvider } from "../core/model-invoke";
import type { ApplyEffectSinks } from "../core/apply-effect";
import type { ApplyPatchInput } from "../core/apply-patch";
import { resolveCurrentAdopted } from "../core/adoption-status";
import type { RuntimeQuestionAutoResolveConfig } from "../core/capability-policy";
import {
  runQuestionAutoResolution,
  type QuestionAutoResolutionResult,
} from "./question-auto-resolution";
import { runScheduler, type SchedulerResult } from "./scheduler";
import type { EngineVault } from "../core/vault-shape";

export type OperationalWorkResult = {
  readonly scheduler: SchedulerResult;
  readonly outbox: ReadonlyArray<ExternalDispatchResult>;
  readonly questionAutoResolution: QuestionAutoResolutionResult;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
};

export async function runOperationalWork(opts: {
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly registry: ProcessorRegistry;
  readonly projection: ProjectionDb;
  readonly answers?: AnswersDb;
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
  readonly questionAutoResolve?: RuntimeQuestionAutoResolveConfig;
  /**
   * Forwarded to question auto-resolution: fired once per durable
   * auto-answer, so the host's tick-scoped `questions.changed` flag catches
   * changes that bypass the `recordQuestion` sink.
   */
  readonly onQuestionsChanged?: () => void;
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

  const questionAutoResolution =
    opts.answers === undefined || opts.questionAutoResolve === undefined
      ? emptyQuestionAutoResolution()
      : await runQuestionAutoResolution({
          config: opts.questionAutoResolve,
          vault: opts.vault,
          adopted: resolveCurrentAdopted(opts.currentAdopted, opts.adopted),
          registry: opts.registry,
          projection: opts.projection,
          answers: opts.answers,
          sinks: opts.sinks,
          resolveTree: opts.resolveTree,
          now: opts.now,
          resolveGrants: opts.resolveGrants,
          extensionIdFor: opts.extensionIdFor,
          ...(opts.onQuestionsChanged !== undefined
            ? { onQuestionsChanged: opts.onQuestionsChanged }
            : {}),
          ...(opts.operational !== undefined
            ? { operational: opts.operational }
            : {}),
          ledger: opts.ledger,
          ...(opts.executionState !== undefined
            ? { executionState: opts.executionState }
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

  return Object.freeze({
    scheduler,
    outbox,
    questionAutoResolution,
    diagnostics: Object.freeze([
      ...scheduler.diagnostics,
      ...questionAutoResolution.diagnostics,
    ]),
  });
}

function emptyQuestionAutoResolution(): QuestionAutoResolutionResult {
  return Object.freeze({
    enabled: false,
    considered: 0,
    answered: 0,
    skipped: 0,
    handlerFailed: 0,
    diagnostics: Object.freeze([]),
  });
}
