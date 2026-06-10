// engine/operational/operational-query-view: read-only operational state for processors.
//
// Recovery processors need to inspect durable engine state such as failed
// outbox rows, but they must not import SQLite accessors or mutate tables
// directly. This adapter exposes a small typed query surface on
// `ctx.operational`; mutations still happen only through Effects routed by
// the engine.

import type {
  OperationalOutboxRow,
  OperationalQuarantineRow,
  OperationalRunRow,
  OperationalQueryView,
} from "../../core/processor";
import type { LedgerDb } from "../../ledger/db";
import { orphanRuns, type RunRow } from "../../ledger/runs";
import type { OutboxDb } from "../../outbox/db";
import { queryOutbox, type OutboxRow } from "../../outbox/dispatch";
import type {
  ProcessorExecutionState,
  ProcessorQuarantineSnapshot,
} from "../../processors/execution-state";

export const DEFAULT_ORPHAN_RUN_AGE_MS = 5 * 60 * 1000;

export function buildOperationalQueryView(opts: {
  readonly outbox: OutboxDb;
  readonly ledger: LedgerDb;
  readonly executionState: ProcessorExecutionState;
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
        orphanRuns(
          opts.ledger,
          normalizeOrphanRunAgeMs(filter?.runningOlderThanMs),
          now(),
        ).map(toOperationalRunRow),
      ),
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
    error: row.error,
    triggerKind: row.triggerKind,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  });
}
