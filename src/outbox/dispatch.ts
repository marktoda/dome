// outbox-dispatch: the durable boundary for ExternalActionEffect. Owns the
// insert-before-call dispatch path, retry state transitions
// (pending → dispatching → sent / failed / abandoned), attempt-counter bookkeeping,
// the user-triggered replay path, and the read surface for `dome inspect
// outbox`.
//
// Normative references:
//   - docs/wiki/specs/projection-store.md §"Outbox (separate database:
//     outbox.db)" §"Lifecycle" — the canonical state machine.
//   - docs/wiki/specs/effects.md §"ExternalActionEffect" — the input shape.
//
// Structural fences this file upholds:
//   - docs/wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX.md — this
//     file is the named structural enforcement point ("The applier in
//     `src/engine/core/apply-effect.ts` routes `external` effects to
//     `src/outbox/dispatch.ts` exclusively"). Every ExternalActionEffect
//     emitted by a processor flows through `dispatchExternalEffect` here:
//     it inserts via `insertPending` before any external call is attempted.
//   - The UNIQUE constraint on `idempotency_key` in `outbox.db` is
//     respected via `INSERT OR IGNORE` — a processor re-emitting the
//     same effect on retry produces one row, one external call.
//
// Mitigated gotchas:
//   - docs/wiki/gotchas/outbox-stuck.md — per the engine-asks recovery
//     model in cli.md §"dome resolve", `replayFailed` and `markAbandoned`
//     are the state-machine transitions invoked by the engine-owned
//     OutboxRecoveryEffect sink after a recovery answer handler emits
//     `retry` or `abandon`.
//     `queryOutbox` is the data source for `dome inspect outbox`. Failed
//     rows are never auto-pruned (per the gotcha file: "dropped external
//     actions are a serious failure mode").
//
// Lifecycle invariants (the state machine this file encodes):
//
//   insertPending     → row created, status="pending", attempts=0.
//
//   dispatchExternalEffect
//                     → insertPending, call the registered handler, then
//                       markSent / incrementAttempts / markFailed.
//
//   claimPending      → "pending" → "dispatching". Atomic lease before any
//                       external handler runs.
//
//   recoverExpiredDispatching
//                     → expired "dispatching" → "pending" (attempts++, retry
//                       backoff) or "failed" at max_attempts. The
//                       crash-recovery drain at the top of
//                       dispatchPendingOutbox; consumes an attempt because
//                       the crashed handler may have already fired.
//
//   incrementAttempts → "dispatching" → "pending", attempts++. Exposed for
//                       tests and manual recovery paths; the dispatch
//                       helper above performs the normal retry decision.
//
//   markSent          → "pending" → "sent". Terminal. Sets external_id,
//                       sent_at. UPDATE filters by status="pending" so
//                       calling on an already-terminal row is a no-op.
//
//   markFailed        → "pending" → "failed". Terminal. Same no-op
//                       semantics on already-terminal rows.
//
//   markAbandoned     → "failed" → "abandoned". Terminal. (Per the gotcha:
//                       "useful for entries that have become irrelevant"—
//                       so we transition from `failed`, not from arbitrary
//                       prior state.)
//
//   replayFailed      → "failed" → "pending", attempts=0, last_error=NULL.
//                       The user-invoked recovery path.
//
// Imports (tight by design — outbox is the SQLite boundary):
//   - `bun:sqlite` (transitively, via `OutboxDb` from `./db`).
//   - `../core/effect` for the `ExternalActionEffect` type.
//   - `../core/source-ref` for the `SourceRef` type (deserialization
//     boundary).
//   - `./db` for the `OutboxDb` handle.
//
// House-style notes (mirrors src/projections/facts.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - JSON columns (`payload_json`, `source_refs`) serialized via
//     `JSON.stringify` on write, parsed on read.
//   - Returned arrays are `Object.freeze`'d.
//   - `noUncheckedIndexedAccess` discipline: row arrays are mapped
//     functionally; no index access into the raw `.all()` result.

import { JsonValueSchema, type ExternalActionEffect } from "../core/effect";
import type { SourceRef } from "../core/source-ref";
import { rowCodec } from "../sqlite/row-codec";
import {
  parseJsonColumn,
  parseSourceRefsColumn,
} from "../sqlite/row-json";
import { mapRows } from "../sqlite/rows";
import type { OutboxDb } from "./db";

// ----- Constants ------------------------------------------------------------

/**
 * The default `max_attempts` written to new outbox rows. Per
 * [[wiki/gotchas/outbox-stuck]]: "exponential backoff up to maxAttempts,
 * default 3". The schema's DDL also defaults `max_attempts` to 3; we set
 * it explicitly on insert so the row is self-describing if the schema
 * default ever changes.
 */
const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_EXTERNAL_HANDLER_TIMEOUT_MS = 30_000;

// ----- Public types ---------------------------------------------------------

export type OutboxInsertOpts = {
  readonly effect: ExternalActionEffect;
  /** The RunRecord id that emitted this effect. Stored on the row for audit. */
  readonly runId: string;
  readonly now?: Date;
};

/**
 * The four terminal+transient states a row can be in. Pinned by the
 * spec §"Outbox" `status` column and the lifecycle section.
 */
export type OutboxStatus =
  | "pending"
  | "dispatching"
  | "sent"
  | "failed"
  | "abandoned";

/**
 * Row shape returned by `queryOutbox`. JSON columns are deserialized.
 * Nullable columns are typed `T | null` (not `T | undefined`) so SQL
 * NULL maps cleanly under `exactOptionalPropertyTypes`.
 */
export type OutboxRow = {
  readonly id: number;
  readonly capability: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
  readonly status: OutboxStatus;
  readonly externalId: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly enqueuedAt: string;
  readonly nextAttemptAt: string;
  readonly sentAt: string | null;
  readonly lastError: string | null;
  readonly runId: string;
};

export type OutboxQueryFilter = {
  readonly status?: OutboxStatus;
  readonly capability?: string;
  /**
   * Match only rows enqueued strictly before this timestamp. Used by
   * operational drains to avoid immediately retrying rows that were
   * created by the same scheduler/job pump.
   */
  readonly enqueuedBefore?: Date;
  /**
   * Match only rows whose retry cursor is due at or before this timestamp.
   * The outbox dispatcher uses this to enforce retry backoff.
   */
  readonly nextAttemptAtOrBefore?: Date;
  /**
   * Match only rows whose `enqueued_at` is older than `now - hours`. Used
   * by `dome inspect outbox --age 24h+` to surface stuck rows.
   * Computed against the current wall clock at query time.
   */
  readonly olderThanHours?: number;
};

export type ExternalHandlerInput = {
  readonly capability: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
  readonly runId: string;
  /**
   * 1-based attempt number for the call the engine is about to make.
   * Previous failed attempts are already recorded on the outbox row.
   */
  readonly attempt: number;
  /**
   * Engine-owned cancellation signal for this single external attempt.
   * Handlers should pass it to HTTP/SDK calls where possible and stop work
   * promptly when aborted.
   */
  readonly signal: AbortSignal;
  /**
   * Absolute vault root, injected by `openVaultRuntime` for BUNDLE-discovered
   * handlers (the runtime wraps each `external-handlers/*.ts` handler to
   * merge it in — see `deriveExternalHandlers`). Handlers that run
   * vault-local commands (e.g. `dome.sources`' `sources.fetch`) use it as
   * the spawn cwd. Caller-injected registries receive whatever the caller
   * wraps in; the dispatch layer itself never sets this field.
   */
  readonly vaultPath?: string;
};

export type ExternalHandlerResult = {
  readonly externalId: string;
  /**
   * True when the handler did not perform a fresh side effect, but discovered
   * that the idempotency key had already succeeded remotely.
   */
  readonly recovered?: boolean;
};

export type ExternalHandler = (
  input: ExternalHandlerInput,
) => Promise<ExternalHandlerResult>;

export type ExternalHandlerRegistry =
  | ReadonlyMap<string, ExternalHandler>
  | Readonly<Record<string, ExternalHandler>>;

export type ExternalDispatchResult =
  | {
      readonly kind: "sent";
      readonly idempotencyKey: string;
      readonly externalId: string;
      readonly recovered: boolean;
    }
  | {
      readonly kind: "already-sent";
      readonly idempotencyKey: string;
      readonly externalId: string;
    }
  | {
      readonly kind: "pending";
      readonly idempotencyKey: string;
      readonly attempts: number;
      readonly maxAttempts: number;
      readonly lastError: string;
      readonly nextAttemptAt: string;
    }
  | {
      readonly kind: "failed";
      readonly idempotencyKey: string;
      readonly attempts: number;
      readonly maxAttempts: number;
      readonly lastError: string;
      readonly nextAttemptAt: string;
    }
  | {
      readonly kind: "skipped";
      readonly idempotencyKey: string;
      readonly status: "failed" | "abandoned";
    }
  | {
      readonly kind: "cancelled";
      readonly idempotencyKey: string;
      readonly attempts: number;
      readonly maxAttempts: number;
      readonly lastError: string;
    };

type OutboxDispatchControls = {
  readonly handlerTimeoutMs?: number;
  readonly signal?: AbortSignal;
};

// ----- SQL ------------------------------------------------------------------

const INSERT_PENDING_SQL = `
INSERT OR IGNORE INTO outbox (
  capability, idempotency_key, payload_json, source_refs,
  status, attempts, max_attempts, enqueued_at, next_attempt_at, run_id
) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
`.trim();

const MARK_SENT_SQL = `
UPDATE outbox
SET status = 'sent', external_id = ?, sent_at = ?
WHERE idempotency_key = ? AND status IN ('pending', 'dispatching')
`.trim();

const MARK_FAILED_SQL = `
UPDATE outbox
SET status = 'failed', last_error = ?
WHERE idempotency_key = ? AND status IN ('pending', 'dispatching')
`.trim();

const INCREMENT_ATTEMPTS_SQL = `
UPDATE outbox
SET status = 'pending', attempts = attempts + 1, last_error = ?, next_attempt_at = ?
WHERE idempotency_key = ? AND status IN ('pending', 'dispatching')
`.trim();

const RECORD_FAILED_ATTEMPT_SQL = `
UPDATE outbox
SET status = ?,
    attempts = attempts + 1,
    last_error = ?,
    next_attempt_at = ?
WHERE idempotency_key = ? AND status IN ('pending', 'dispatching')
`.trim();

const CLAIM_PENDING_SQL = `
UPDATE outbox
SET status = 'dispatching', last_error = NULL, next_attempt_at = ?
WHERE idempotency_key = ? AND status = 'pending' AND next_attempt_at <= ?
RETURNING id, capability, idempotency_key, payload_json, source_refs,
          status, external_id, attempts, max_attempts, enqueued_at,
          next_attempt_at, sent_at, last_error, run_id
`.trim();

const RELEASE_DISPATCHING_SQL = `
UPDATE outbox
SET status = 'pending', last_error = ?, next_attempt_at = ?
WHERE idempotency_key = ? AND status = 'dispatching'
`.trim();

const RECOVER_EXPIRED_DISPATCHING_SQL = `
UPDATE outbox
SET attempts = attempts + 1,
    status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'pending' END,
    last_error = ?,
    next_attempt_at = ?
WHERE idempotency_key = ? AND status = 'dispatching' AND next_attempt_at <= ?
`.trim();

const MARK_ABANDONED_SQL = `
UPDATE outbox
SET status = 'abandoned'
WHERE idempotency_key = ? AND status = 'failed'
`.trim();

const MARK_ABANDONED_IF_GENERATION_SQL = `
UPDATE outbox
SET status = 'abandoned'
WHERE idempotency_key = ?
  AND status = 'failed'
  AND attempts = ?
  AND next_attempt_at = ?
  AND (
    (last_error IS NULL AND ? IS NULL)
    OR last_error = ?
  )
`.trim();

const REPLAY_FAILED_SQL = `
UPDATE outbox
SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = ?
WHERE idempotency_key = ? AND status = 'failed'
`.trim();

const REPLAY_FAILED_IF_GENERATION_SQL = `
UPDATE outbox
SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = ?
WHERE idempotency_key = ?
  AND status = 'failed'
  AND attempts = ?
  AND next_attempt_at = ?
  AND (
    (last_error IS NULL AND ? IS NULL)
    OR last_error = ?
  )
`.trim();

const SELECT_OUTBOX_BASE_SQL = `
SELECT id, capability, idempotency_key, payload_json, source_refs,
       status, external_id, attempts, max_attempts, enqueued_at,
       next_attempt_at, sent_at, last_error, run_id
FROM outbox
`.trim();

const SELECT_OUTBOX_BY_KEY_SQL = `${SELECT_OUTBOX_BASE_SQL} WHERE idempotency_key = ?`;

// ----- Row shape ------------------------------------------------------------

type OutboxRawRow = {
  readonly id: number;
  readonly capability: string;
  readonly idempotency_key: string;
  readonly payload_json: string;
  readonly source_refs: string;
  readonly status: string;
  readonly external_id: string | null;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly enqueued_at: string;
  readonly next_attempt_at: string;
  readonly sent_at: string | null;
  readonly last_error: string | null;
  readonly run_id: string;
};

// ----- Public functions -----------------------------------------------------

/**
 * Insert a new outbox row in `status: "pending"`. `INSERT OR IGNORE` on
 * the `idempotency_key` UNIQUE constraint — re-emission of an effect
 * with the same key is a silent no-op (the existing row is unchanged).
 *
 * This is the **only** path by which an ExternalActionEffect lands in
 * the outbox; pinned by
 * [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]].
 *
 * Throws on SQLite-level failure (disk full, schema-mismatch, etc.).
 * Programmer errors at the type boundary (e.g., an effect missing
 * `idempotencyKey`) are caught at construction time by the
 * `externalActionEffect()` helper / Zod schema; this function trusts
 * the typed input.
 */
export function insertPending(db: OutboxDb, opts: OutboxInsertOpts): void {
  const e = opts.effect;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  db.raw.query(INSERT_PENDING_SQL).run(
    e.capability,
    e.idempotencyKey,
    JSON.stringify(e.payload),
    JSON.stringify(e.sourceRefs),
    DEFAULT_MAX_ATTEMPTS,
    nowIso,
    nowIso,
    opts.runId,
  );
}

/**
 * Insert the outbox row, then dispatch it through the registered capability
 * handler. This is the no-fire-and-forget boundary: the durable row is
 * written before the external handler is invoked, and every handler outcome
 * transitions the row through the outbox state machine.
 *
 * Duplicate idempotency keys are safe. If the existing row is already sent,
 * the cached external id is returned and the handler is not called. If the
 * row is pending, the function performs one retry attempt. Failed/abandoned
 * rows are left terminal until the explicit replay path resets them.
 */
export async function dispatchExternalEffect(
  db: OutboxDb,
  opts: {
    readonly effect: ExternalActionEffect;
    readonly runId: string;
    readonly handlers: ExternalHandlerRegistry;
    readonly now?: Date;
  } & OutboxDispatchControls,
): Promise<ExternalDispatchResult> {
  const now = opts.now ?? new Date();
  insertPending(db, { effect: opts.effect, runId: opts.runId, now });
  const row = getOutboxByIdempotencyKey(db, opts.effect.idempotencyKey);
  if (row === null) {
    const msg =
      `Outbox dispatch invariant failed: row '${opts.effect.idempotencyKey}' ` +
      "was not readable after insert.";
    throw new Error(msg);
  }
  return dispatchOutboxRow(db, row, opts.handlers, now, opts);
}

/**
 * Retry pending rows that survived a prior crash or process exit. The caller
 * chooses when to invoke this drain; the function performs at most one
 * handler call per row per invocation so retries remain externally paced.
 */
export async function dispatchPendingOutbox(
  db: OutboxDb,
  opts: {
    readonly handlers: ExternalHandlerRegistry;
    readonly limit?: number;
    readonly enqueuedBefore?: Date;
    readonly now?: Date;
  } & OutboxDispatchControls,
): Promise<ReadonlyArray<ExternalDispatchResult>> {
  const now = opts.now ?? new Date();
  recoverExpiredDispatching(db, now);
  const pending = queryOutbox(db, {
    status: "pending",
    nextAttemptAtOrBefore: now,
    ...(opts.enqueuedBefore !== undefined
      ? { enqueuedBefore: opts.enqueuedBefore }
      : {}),
  });
  const bounded =
    opts.limit === undefined ? pending : pending.slice(0, opts.limit);
  const results: ExternalDispatchResult[] = [];
  for (const row of bounded) {
    results.push(await dispatchOutboxRow(db, row, opts.handlers, now, opts));
  }
  return Object.freeze(results);
}

/**
 * Mark a row sent. Updates `status` to `"sent"`, sets `external_id`
 * (the remote system's id) and `sent_at`. UPDATE filters by
 * `status = 'pending'` so calling on an already-terminal row is a
 * no-op — defensive against concurrent retries.
 *
 * If no row exists with the given `idempotencyKey` (e.g., the caller
 * passes a stale key, or the row was wiped on a schema-mismatch), the
 * UPDATE affects 0 rows and the call silently succeeds. The caller is
 * responsible for first inserting via `insertPending`; this file does
 * not signal "row missing" because in the normal flow the row is
 * guaranteed to exist (the engine inserts before dispatching).
 */
export function markSent(
  db: OutboxDb,
  idempotencyKey: string,
  externalId: string,
  sentAt: Date,
): void {
  db.raw
    .query(MARK_SENT_SQL)
    .run(externalId, sentAt.toISOString(), idempotencyKey);
}

/**
 * Mark a row failed (terminal — attempts exhausted). Updates `status`
 * to `"failed"` and records the last error message. UPDATE filters by
 * `status = 'pending'` so a double-call is a no-op.
 *
 * Per the spec §"Lifecycle": the caller (engine retry loop) decides
 * when attempts are exhausted; this function just records the terminal
 * state.
 */
export function markFailed(
  db: OutboxDb,
  idempotencyKey: string,
  lastError: string,
): void {
  db.raw.query(MARK_FAILED_SQL).run(lastError, idempotencyKey);
}

/**
 * Increment the attempt counter and record the most recent error. The
 * row stays in `status: "pending"` — this is the transient-retry path.
 *
 * Per the lifecycle invariants in the file banner: **the caller** is
 * responsible for comparing `attempts` to `max_attempts` after this
 * call and invoking `markFailed` when exhausted. This file deliberately
 * does not auto-transition; the engine's retry policy lives elsewhere.
 *
 * UPDATE filters by `status = 'pending'` so a call against an
 * already-terminal row is a no-op (concurrent-mark-sent race
 * protection).
 */
export function incrementAttempts(
  db: OutboxDb,
  idempotencyKey: string,
  lastError: string,
  nextAttemptAt: Date = new Date(),
): void {
  db.raw
    .query(INCREMENT_ATTEMPTS_SQL)
    .run(lastError, nextAttemptAt.toISOString(), idempotencyKey);
}

/**
 * Recover rows whose dispatch claim expired — the process died (or hung past
 * its lease) mid-handler, so nothing in-process recorded the outcome. Each
 * expired claim **consumes an attempt**: the external call may or may not
 * have gone out before the crash, and an unbounded requeue would let a
 * handler that reliably crashes the host re-fire the call forever across
 * restarts. Mirrors the scheduled-jobs recovery split
 * (src/projections/jobs.ts `recoverExpiredRunningJobs`): under
 * `max_attempts` the row returns to `pending` with retry backoff; at
 * `max_attempts` it goes terminal `failed`, which routes it to the
 * engine-asks recovery path (dome.health questions + `dome resolve
 * retry|abandon`).
 *
 * The UPDATE re-checks `status = 'dispatching' AND next_attempt_at <= now`
 * per row, so a claim completed concurrently (markSent / recordFailedAttempt)
 * is untouched.
 */
export function recoverExpiredDispatching(
  db: OutboxDb,
  now: Date = new Date(),
): void {
  const expired = queryOutbox(db, {
    status: "dispatching",
    nextAttemptAtOrBefore: now,
  });
  for (const row of expired) {
    const attempts = row.attempts + 1;
    const terminal = attempts >= row.maxAttempts;
    const nextAttemptAt = terminal
      ? now
      : computeNextAttemptAt(now, attempts);
    db.raw
      .query(RECOVER_EXPIRED_DISPATCHING_SQL)
      .run(
        "Dispatch claim expired before completion (process exited or hung mid-handler).",
        nextAttemptAt.toISOString(),
        row.idempotencyKey,
        now.toISOString(),
      );
  }
}

/**
 * Mark a row abandoned. Invoked by the engine-owned OutboxRecoveryEffect
 * sink when a recovery answer handler emits `action: "abandon"` (per
 * [[wiki/specs/cli]] §"`dome resolve`" and [[wiki/gotchas/outbox-stuck]]).
 * Useful for entries that have become irrelevant (the meeting already
 * happened; the notification window passed). Abandoned rows "stop
 * attracting attention" — they remain in the table for audit but are
 * filtered out of default `dome inspect outbox` views.
 *
 * UPDATE filters by `status = 'failed'`. Per the spec lifecycle: only
 * already-failed rows can be abandoned; abandoning a pending row would
 * race with the retry loop. If a user wants to abandon a pending row,
 * they first need to wait for it to terminally fail (or surface a
 * separate cancellation API in a future phase).
 */
export function markAbandoned(db: OutboxDb, idempotencyKey: string): boolean {
  const result = db.raw.query(MARK_ABANDONED_SQL).run(idempotencyKey);
  return result.changes > 0;
}

/**
 * Re-queue a previously-failed row. Invoked by the engine-owned
 * OutboxRecoveryEffect sink when a recovery answer handler emits
 * `action: "retry"` (per [[wiki/specs/cli]] §"`dome resolve`") — typically
 * after the underlying cause has been fixed
 * (rotated credentials, remote service came back up, etc.). Resets
 * `attempts` to 0 and clears `last_error`; the row returns to
 * `status: "pending"` for the dispatcher to pick up on the next pass.
 *
 * UPDATE filters by `status = 'failed'` — replaying a `pending`,
 * `sent`, or `abandoned` row is a no-op. Replaying an abandoned row
 * intentionally requires a separate "un-abandon" path (not in v1
 * Phase 4); abandoned is the loudest terminal state and resurrecting
 * it silently would defeat the user's intent.
 */
export function replayFailed(
  db: OutboxDb,
  idempotencyKey: string,
  now: Date = new Date(),
): boolean {
  const result = db.raw
    .query(REPLAY_FAILED_SQL)
    .run(now.toISOString(), idempotencyKey);
  return result.changes > 0;
}

export function recoverFailedOutboxRow(
  db: OutboxDb,
  opts: {
    readonly idempotencyKey: string;
    readonly action: "retry" | "abandon";
    readonly failureToken?: string;
    readonly now?: Date;
  },
): boolean {
  const current = getOutboxByIdempotencyKey(db, opts.idempotencyKey);
  if (current === null || current.status !== "failed") return false;
  if (
    opts.failureToken !== undefined &&
    opts.failureToken !== failureToken(current)
  ) {
    return false;
  }

  if (opts.failureToken === undefined) {
    return opts.action === "retry"
      ? replayFailed(db, opts.idempotencyKey, opts.now)
      : markAbandoned(db, opts.idempotencyKey);
  }

  const lastError = current.lastError;
  const params = [
    ...(opts.action === "retry"
      ? [(opts.now ?? new Date()).toISOString()]
      : []),
    opts.idempotencyKey,
    current.attempts,
    current.nextAttemptAt,
    lastError,
    lastError,
  ] as const;
  const result =
    opts.action === "retry"
      ? db.raw.query(REPLAY_FAILED_IF_GENERATION_SQL).run(...params)
      : db.raw
          .query(MARK_ABANDONED_IF_GENERATION_SQL)
          .run(
            opts.idempotencyKey,
            current.attempts,
            current.nextAttemptAt,
            lastError,
            lastError,
          );
  return result.changes > 0;
}

/**
 * Read outbox rows, optionally filtered. The query surface for
 * `dome inspect outbox`. Returns a frozen array; ordering is
 * insertion order (`ORDER BY id`).
 *
 * Filters compose with AND. `olderThanHours` is computed against the
 * current wall clock at query time (UTC ISO-8601 comparison — lexical
 * comparison is correct for the canonical ISO-8601 format SQLite
 * stores).
 */
export function queryOutbox(
  db: OutboxDb,
  filter?: OutboxQueryFilter,
): ReadonlyArray<OutboxRow> {
  const clauses: string[] = [];
  const params: Array<string> = [];

  if (filter?.status !== undefined) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter?.capability !== undefined) {
    clauses.push("capability = ?");
    params.push(filter.capability);
  }
  if (filter?.enqueuedBefore !== undefined) {
    clauses.push("enqueued_at < ?");
    params.push(filter.enqueuedBefore.toISOString());
  }
  if (filter?.nextAttemptAtOrBefore !== undefined) {
    clauses.push("next_attempt_at <= ?");
    params.push(filter.nextAttemptAtOrBefore.toISOString());
  }
  if (filter?.olderThanHours !== undefined) {
    const cutoff = new Date(
      Date.now() - filter.olderThanHours * 60 * 60 * 1000,
    ).toISOString();
    clauses.push("enqueued_at < ?");
    params.push(cutoff);
  }

  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const sql = `${SELECT_OUTBOX_BASE_SQL}${where} ORDER BY id`;

  const rows = db.raw.query<OutboxRawRow, string[]>(sql).all(...params);
  return mapRows(rows, rowToOutboxRow);
}

export function getOutboxByIdempotencyKey(
  db: OutboxDb,
  idempotencyKey: string,
): OutboxRow | null {
  const row = db.raw
    .query<OutboxRawRow, [string]>(SELECT_OUTBOX_BY_KEY_SQL)
    .get(idempotencyKey);
  return row === null ? null : rowToOutboxRow(row);
}

// ----- internals ------------------------------------------------------------

async function dispatchOutboxRow(
  db: OutboxDb,
  row: OutboxRow,
  handlers: ExternalHandlerRegistry,
  now: Date,
  controls: OutboxDispatchControls,
): Promise<ExternalDispatchResult> {
  if (row.status === "sent") {
    return Object.freeze({
      kind: "already-sent",
      idempotencyKey: row.idempotencyKey,
      externalId: row.externalId ?? "",
    });
  }
  if (row.status === "dispatching") {
    return Object.freeze({
      kind: "pending" as const,
      idempotencyKey: row.idempotencyKey,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      lastError: row.lastError ?? `Dispatch already claimed until ${row.nextAttemptAt}.`,
      nextAttemptAt: row.nextAttemptAt,
    });
  }
  if (row.status === "failed" || row.status === "abandoned") {
    return Object.freeze({
      kind: "skipped",
      idempotencyKey: row.idempotencyKey,
      status: row.status,
    });
  }
  if (Date.parse(row.nextAttemptAt) > now.getTime()) {
    return Object.freeze({
      kind: "pending",
      idempotencyKey: row.idempotencyKey,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      lastError: row.lastError ?? `Retry not due until ${row.nextAttemptAt}.`,
      nextAttemptAt: row.nextAttemptAt,
    });
  }
  if (controls.signal?.aborted === true) {
    return cancelledDispatchResult(row, "External handler dispatch was cancelled.");
  }

  const claimed = claimPendingOutboxRow(db, row, now, controls);
  if (claimed === null) {
    const current = getOutboxByIdempotencyKey(db, row.idempotencyKey);
    return current === null
      ? Object.freeze({
          kind: "pending" as const,
          idempotencyKey: row.idempotencyKey,
          attempts: row.attempts,
          maxAttempts: row.maxAttempts,
          lastError: "Outbox row disappeared before dispatch claim.",
          nextAttemptAt: row.nextAttemptAt,
        })
      : dispatchOutboxRow(db, current, handlers, now, {
          ...controls,
          signal: alreadyClaimedAbortSignal(),
        });
  }
  row = claimed;

  const handler = lookupHandler(handlers, row.capability);
  if (handler === undefined) {
    const msg = `No external handler registered for capability '${row.capability}'.`;
    return recordFailedAttempt(db, row, msg, { terminal: true, now });
  }

  try {
    const result = await runExternalHandler({
      handler,
      input: {
        capability: row.capability,
        idempotencyKey: row.idempotencyKey,
        payload: row.payload,
        sourceRefs: row.sourceRefs,
        runId: row.runId,
        attempt: row.attempts + 1,
      },
      timeoutMs:
        controls.handlerTimeoutMs ?? DEFAULT_EXTERNAL_HANDLER_TIMEOUT_MS,
      ...(controls.signal !== undefined ? { signal: controls.signal } : {}),
    });
    if (typeof result.externalId !== "string" || result.externalId.length === 0) {
      throw new Error("External handler returned an empty externalId.");
    }
    markSent(db, row.idempotencyKey, result.externalId, new Date());
    return Object.freeze({
      kind: "sent",
      idempotencyKey: row.idempotencyKey,
      externalId: result.externalId,
      recovered: result.recovered ?? false,
    });
  } catch (e) {
    if (isOutboxDispatchCancelled(e)) {
      releaseDispatchingClaim(db, row, null, now);
      return cancelledDispatchResult(row, errorMessage(e));
    }
    return recordFailedAttempt(db, row, errorMessage(e), {
      terminal: false,
      now,
    });
  }
}

function claimPendingOutboxRow(
  db: OutboxDb,
  row: OutboxRow,
  now: Date,
  controls: OutboxDispatchControls,
): OutboxRow | null {
  const leaseMs =
    controls.handlerTimeoutMs ?? DEFAULT_EXTERNAL_HANDLER_TIMEOUT_MS;
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const claimed = db.raw
    .query<OutboxRawRow, [string, string, string]>(CLAIM_PENDING_SQL)
    .get(
      leaseUntil.toISOString(),
      row.idempotencyKey,
      now.toISOString(),
    );
  return claimed === null ? null : rowToOutboxRow(claimed);
}

function releaseDispatchingClaim(
  db: OutboxDb,
  row: OutboxRow,
  lastError: string | null,
  now: Date,
): void {
  db.raw
    .query(RELEASE_DISPATCHING_SQL)
    .run(lastError, now.toISOString(), row.idempotencyKey);
}

function alreadyClaimedAbortSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

async function runExternalHandler(opts: {
  readonly handler: ExternalHandler;
  readonly input: Omit<ExternalHandlerInput, "signal">;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<ExternalHandlerResult> {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error("External handler timeout must be a positive number.");
  }
  if (opts.signal?.aborted === true) {
    throw outboxDispatchCancelled("External handler dispatch was cancelled.");
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(
        new Error(
          `External handler exceeded timeout of ${opts.timeoutMs}ms.`,
        ),
      );
    }, opts.timeoutMs);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    abort = () => {
      controller.abort();
      reject(outboxDispatchCancelled("External handler dispatch was cancelled."));
    };
    opts.signal?.addEventListener("abort", abort, { once: true });
  });

  try {
    return await Promise.race([
      opts.handler({
        ...opts.input,
        signal: controller.signal,
      }),
      timeoutPromise,
      abortPromise,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abort !== undefined && opts.signal !== undefined) {
      opts.signal.removeEventListener("abort", abort);
    }
  }
}

function cancelledDispatchResult(
  row: OutboxRow,
  lastError: string,
): ExternalDispatchResult {
  return Object.freeze({
    kind: "cancelled",
    idempotencyKey: row.idempotencyKey,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError,
  });
}

function recordFailedAttempt(
  db: OutboxDb,
  row: OutboxRow,
  lastError: string,
  opts: { readonly terminal: boolean; readonly now: Date },
): ExternalDispatchResult {
  const attempts = row.attempts + 1;
  const terminal = opts.terminal || attempts >= row.maxAttempts;
  const nextAttemptAt = terminal
    ? opts.now
    : computeNextAttemptAt(opts.now, attempts);
  const status = terminal ? "failed" : "pending";
  db.raw
    .query(RECORD_FAILED_ATTEMPT_SQL)
    .run(status, lastError, nextAttemptAt.toISOString(), row.idempotencyKey);
  if (terminal) {
    return Object.freeze({
      kind: "failed",
      idempotencyKey: row.idempotencyKey,
      attempts,
      maxAttempts: row.maxAttempts,
      lastError,
      nextAttemptAt: nextAttemptAt.toISOString(),
    });
  }
  return Object.freeze({
    kind: "pending",
    idempotencyKey: row.idempotencyKey,
    attempts,
    maxAttempts: row.maxAttempts,
    lastError,
    nextAttemptAt: nextAttemptAt.toISOString(),
  });
}

function failureToken(row: OutboxRow): string {
  return encodeURIComponent(
    JSON.stringify({
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt,
      lastError: row.lastError,
    }),
  );
}

function computeNextAttemptAt(now: Date, failedAttemptCount: number): Date {
  const exponent = Math.max(0, failedAttemptCount - 1);
  const delay = Math.min(
    BASE_RETRY_DELAY_MS * 2 ** exponent,
    MAX_RETRY_DELAY_MS,
  );
  return new Date(now.getTime() + delay);
}

function lookupHandler(
  handlers: ExternalHandlerRegistry,
  capability: string,
): ExternalHandler | undefined {
  if (isReadonlyMap(handlers)) {
    return handlers.get(capability);
  }
  return handlers[capability];
}

function isReadonlyMap(
  handlers: ExternalHandlerRegistry,
): handlers is ReadonlyMap<string, ExternalHandler> {
  return typeof (handlers as ReadonlyMap<string, ExternalHandler>).get === "function";
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const OUTBOX_DISPATCH_CANCELLED = new WeakSet<object>();

function outboxDispatchCancelled(message: string): Error {
  const error = new Error(message);
  OUTBOX_DISPATCH_CANCELLED.add(error);
  return error;
}

function isOutboxDispatchCancelled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    OUTBOX_DISPATCH_CANCELLED.has(error)
  );
}

// Row → OutboxRow codec is defined below, after `OUTBOX_STATUSES` (the codec
// references it). Deserializes JSON columns, resolves source refs, and narrows
// `status`, throwing on a value corrupted at the SQL boundary.

const OUTBOX_STATUSES = [
  "pending",
  "dispatching",
  "sent",
  "failed",
  "abandoned",
] as const satisfies ReadonlyArray<OutboxStatus>;

// The DDL doesn't carry a CHECK constraint on `status` (v1 simplicity); the
// `enumCol` reader below is the read-side fence.
const outboxCodec = rowCodec<OutboxRawRow>("outbox");

const rowToOutboxRow = outboxCodec.define<OutboxRow>({
  id: outboxCodec.col("id"),
  capability: outboxCodec.col("capability"),
  idempotencyKey: outboxCodec.col("idempotency_key"),
  // `custom`, not `jsonCol`: the opaque payload was left unfrozen by the
  // hand-mapper.
  payload: outboxCodec.custom((row) =>
    parseJsonColumn(row.payload_json, "outbox.payload_json", JsonValueSchema),
  ),
  // `parseSourceRefsColumn` already freezes the array it returns.
  sourceRefs: outboxCodec.custom((row) =>
    parseSourceRefsColumn(row.source_refs, "outbox.source_refs"),
  ),
  status: outboxCodec.enumCol("status", OUTBOX_STATUSES),
  externalId: outboxCodec.col("external_id"),
  attempts: outboxCodec.col("attempts"),
  maxAttempts: outboxCodec.col("max_attempts"),
  enqueuedAt: outboxCodec.col("enqueued_at"),
  nextAttemptAt: outboxCodec.col("next_attempt_at"),
  sentAt: outboxCodec.col("sent_at"),
  lastError: outboxCodec.col("last_error"),
  runId: outboxCodec.col("run_id"),
});
