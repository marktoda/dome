// engine/operational-query-view: read-only operational state for processors.
//
// Recovery processors need to inspect durable engine state such as failed
// outbox rows, but they must not import SQLite accessors or mutate tables
// directly. This adapter exposes a small typed query surface on
// `ctx.operational`; mutations still happen only through Effects routed by
// the engine.

import type {
  OperationalOutboxRow,
  OperationalQueryView,
} from "../core/processor";
import type { OutboxDb } from "../outbox/db";
import { queryOutbox, type OutboxRow } from "../outbox/dispatch";

export function buildOperationalQueryView(opts: {
  readonly outbox: OutboxDb;
}): OperationalQueryView {
  return Object.freeze({
    outbox: (filter) =>
      Object.freeze(
        queryOutbox(opts.outbox, filter ?? {}).map(toOperationalOutboxRow),
      ),
  });
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
