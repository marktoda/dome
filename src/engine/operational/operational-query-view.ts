// engine/operational/operational-query-view: read-only operational state for processors.
//
// Recovery processors need to inspect durable engine state such as failed
// outbox rows, but they must not import SQLite accessors or mutate tables
// directly. This adapter exposes a small typed query surface on
// `ctx.operational`; mutations still happen only through Effects routed by
// the engine.

import type {
  OperationalOutboxRow,
  OperationalProposalRow,
  OperationalQuarantineRow,
  OperationalQuestionRow,
  OperationalRunRow,
  OperationalQueryView,
} from "../../core/processor";
import type { LedgerDb } from "../../ledger/db";
import { effectHashCount } from "../../processors/executor";
import {
  orphanRuns,
  queryRuns,
  ORPHAN_RECOVERY_EXCLUDED_PROCESSOR_PREFIXES,
  type RunRow,
} from "../../ledger/runs";
import type { OutboxDb } from "../../outbox/db";
import { queryOutbox, type OutboxRow } from "../../outbox/dispatch";
import type {
  ProcessorExecutionState,
  ProcessorQuarantineSnapshot,
} from "../../processors/execution-state";
import type { QuestionRecord } from "../../projections/questions";
import type {
  PendingProposalRow,
  ProposalStatus,
} from "../../proposals/pending-proposals";

export const DEFAULT_ORPHAN_RUN_AGE_MS = 5 * 60 * 1000;

export function buildOperationalQueryView(opts: {
  readonly outbox: OutboxDb;
  readonly ledger: LedgerDb;
  readonly executionState: ProcessorExecutionState;
  /**
   * Closure over the projection question store, not a raw `ProjectionDb`
   * handle — keeps this builder decoupled from SQLite accessors (see the
   * module comment) the same way `outbox`/`ledger` are already narrow
   * store handles rather than the whole projection surface.
   */
  readonly queryQuestions: (filter?: {
    readonly resolved?: boolean;
    readonly resolvedSince?: string;
  }) => ReadonlyArray<QuestionRecord>;
  /**
   * Closure over the pending-proposals store, mirroring `queryQuestions`'
   * decoupling rationale — keeps this builder ignorant of `ProposalsDb`'s
   * SQLite accessors, just a narrow query function over `PendingProposalRow`.
   */
  readonly queryProposals: (filter?: {
    readonly status?: ProposalStatus;
  }) => ReadonlyArray<PendingProposalRow>;
  readonly now?: () => Date;
}): OperationalQueryView {
  const now = opts.now ?? ((): Date => new Date());
  return Object.freeze({
    outbox: (filter) =>
      Object.freeze(
        queryOutbox(opts.outbox, filter ?? {}).map(toOperationalOutboxRow),
      ),
    quarantines: () =>
      Object.freeze(
        opts.executionState.quarantines().map(toOperationalQuarantineRow),
      ),
    orphanRuns: (filter) =>
      Object.freeze(
        // `ctx.operational.orphanRuns()` feeds the dome.health orphan-run
        // recovery processor, so it excludes the recovery processors' own
        // runs — the detector must not raise self-referential questions about
        // its 5-minute-cadence runs (Task 4b).
        orphanRuns(
          opts.ledger,
          normalizeOrphanRunAgeMs(filter?.runningOlderThanMs),
          now(),
          {
            excludeProcessorIdPrefixes:
              ORPHAN_RECOVERY_EXCLUDED_PROCESSOR_PREFIXES,
          },
        ).map(toOperationalRunRow),
      ),
    questions: (filter) =>
      Object.freeze(opts.queryQuestions(filter).map(toOperationalQuestionRow)),
    runs: (filter) =>
      Object.freeze(
        queryRuns(
          opts.ledger,
          filter?.startedSince === undefined
            ? undefined
            : { sinceIso: filter.startedSince },
        ).map(toOperationalRunRow),
      ),
    proposals: (filter) =>
      Object.freeze(opts.queryProposals(filter).map(toOperationalProposalRow)),
  });
}

function normalizeOrphanRunAgeMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ORPHAN_RUN_AGE_MS;
  if (!Number.isFinite(value)) return DEFAULT_ORPHAN_RUN_AGE_MS;
  return Math.max(Math.trunc(value), DEFAULT_ORPHAN_RUN_AGE_MS);
}

function toOperationalOutboxRow(row: OutboxRow): OperationalOutboxRow {
  return Object.freeze({
    id: row.id,
    capability: row.capability,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    enqueuedAt: row.enqueuedAt,
    nextAttemptAt: row.nextAttemptAt,
    sentAt: row.sentAt,
    lastError: row.lastError,
    sourceRefs: row.sourceRefs,
  });
}

function toOperationalQuarantineRow(
  row: ProcessorQuarantineSnapshot,
): OperationalQuarantineRow {
  return Object.freeze({
    phase: row.key.phase,
    processorId: row.key.processorId,
    processorVersion: row.key.processorVersion,
    triggerHash: row.key.triggerHash,
    quarantineId: row.quarantineId,
    consecutiveRetryableFailures: row.consecutiveRetryableFailures,
    quarantinedAt: row.quarantinedAt.toISOString(),
    reason: row.reason,
  });
}

function toOperationalRunRow(row: RunRow): OperationalRunRow {
  return Object.freeze({
    id: row.id,
    proposalId: row.proposalId,
    processorId: row.processorId,
    processorVersion: row.processorVersion,
    phase: row.phase,
    inputCommit: row.inputCommit,
    outputCommit: row.outputCommit,
    status: row.status,
    costUsd: row.costUsd,
    durationMs: row.durationMs,
    // Derived count only — the raw effect sha256s stay internal to the
    // ledger. 0 on a succeeded run = a genuine no-op (see OperationalRunRow).
    // effectHashCount, not .length: past EFFECT_HASHES_MAX the stored list
    // ends in a count sentinel, and the true total must survive the cap.
    effectCount: effectHashCount(row.effectHashes),
    error: row.error,
    triggerKind: row.triggerKind,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  });
}

function toOperationalQuestionRow(
  row: QuestionRecord,
): OperationalQuestionRow {
  return Object.freeze({
    ...row.effect,
    id: row.id,
    processorId: row.processorId,
    runId: row.runId,
    adoptedCommit: row.adoptedCommit,
    askedAt: row.askedAt,
    answeredAt: row.answeredAt,
    answer: row.answer,
    state: row.answeredAt === null ? "open" : "resolved",
  });
}

function toOperationalProposalRow(
  row: PendingProposalRow,
): OperationalProposalRow {
  return Object.freeze({
    id: row.id,
    processorId: row.processorId,
    reason: row.reason,
    paths: Object.freeze(row.changes.map((change) => change.path)),
    createdAt: row.createdAt,
    status: row.status,
  });
}
