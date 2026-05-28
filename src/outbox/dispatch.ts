// outbox-dispatch: the durable boundary for ExternalActionEffect. Owns the
// insert-before-call dispatch path, retry state transitions
// (pending → sent / failed / abandoned), attempt-counter bookkeeping,
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
//     `src/engine/apply-effect.ts` routes `external` effects to
//     `src/outbox/dispatch.ts` exclusively"). Every ExternalActionEffect
//     emitted by a processor flows through `dispatchExternalEffect` here:
//     it inserts via `insertPending` before any external call is attempted.
//   - The UNIQUE constraint on `idempotency_key` in `outbox.db` is
//     respected via `INSERT OR IGNORE` — a processor re-emitting the
//     same effect on retry produces one row, one external call.
//
// Mitigated gotchas:
//   - docs/wiki/gotchas/outbox-stuck.md — per the engine-asks recovery
//     model in cli.md §"dome answer", `replayFailed` and `markAbandoned`
//     are the answer-handler implementations invoked when the user
//     answers a Question raised on `engine.outbox.terminal-failure`.
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
//   incrementAttempts → status stays "pending", attempts++. Exposed for
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

import type { ExternalActionEffect } from "../core/effect";
import type { SourceRef } from "../core/source-ref";
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

// ----- Public types ---------------------------------------------------------

export type OutboxInsertOpts = {
  readonly effect: ExternalActionEffect;
  /** The RunRecord id that emitted this effect. Stored on the row for audit. */
  readonly runId: string;
};

/**
 * The four terminal+transient states a row can be in. Pinned by the
 * spec §"Outbox" `status` column and the lifecycle section.
 */
export type OutboxStatus = "pending" | "sent" | "failed" | "abandoned";

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
  readonly sentAt: string | null;
  readonly lastError: string | null;
  readonly runId: string;
};

export type OutboxQueryFilter = {
  readonly status?: OutboxStatus;
  readonly capability?: string;
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
    }
  | {
      readonly kind: "failed";
      readonly idempotencyKey: string;
      readonly attempts: number;
      readonly maxAttempts: number;
      readonly lastError: string;
    }
  | {
      readonly kind: "skipped";
      readonly idempotencyKey: string;
      readonly status: "failed" | "abandoned";
    };

// ----- SQL ------------------------------------------------------------------

const INSERT_PENDING_SQL = `
INSERT OR IGNORE INTO outbox (
  capability, idempotency_key, payload_json, source_refs,
  status, attempts, max_attempts, enqueued_at, run_id
) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
`.trim();

const MARK_SENT_SQL = `
UPDATE outbox
SET status = 'sent', external_id = ?, sent_at = ?
WHERE idempotency_key = ? AND status = 'pending'
`.trim();

const MARK_FAILED_SQL = `
UPDATE outbox
SET status = 'failed', last_error = ?
WHERE idempotency_key = ? AND status = 'pending'
`.trim();

const INCREMENT_ATTEMPTS_SQL = `
UPDATE outbox
SET attempts = attempts + 1, last_error = ?
WHERE idempotency_key = ? AND status = 'pending'
`.trim();

const MARK_ABANDONED_SQL = `
UPDATE outbox
SET status = 'abandoned'
WHERE idempotency_key = ? AND status = 'failed'
`.trim();

const REPLAY_FAILED_SQL = `
UPDATE outbox
SET status = 'pending', attempts = 0, last_error = NULL
WHERE idempotency_key = ? AND status = 'failed'
`.trim();

const SELECT_OUTBOX_BASE_SQL = `
SELECT id, capability, idempotency_key, payload_json, source_refs,
       status, external_id, attempts, max_attempts, enqueued_at,
       sent_at, last_error, run_id
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
  db.raw.query(INSERT_PENDING_SQL).run(
    e.capability,
    e.idempotencyKey,
    JSON.stringify(e.payload),
    JSON.stringify(e.sourceRefs),
    DEFAULT_MAX_ATTEMPTS,
    new Date().toISOString(),
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
  },
): Promise<ExternalDispatchResult> {
  insertPending(db, { effect: opts.effect, runId: opts.runId });
  const row = getOutboxByIdempotencyKey(db, opts.effect.idempotencyKey);
  if (row === null) {
    const msg =
      `Outbox dispatch invariant failed: row '${opts.effect.idempotencyKey}' ` +
      "was not readable after insert.";
    throw new Error(msg);
  }
  return dispatchOutboxRow(db, row, opts.handlers);
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
  },
): Promise<ReadonlyArray<ExternalDispatchResult>> {
  const pending = queryOutbox(db, { status: "pending" });
  const bounded =
    opts.limit === undefined ? pending : pending.slice(0, opts.limit);
  const results: ExternalDispatchResult[] = [];
  for (const row of bounded) {
    results.push(await dispatchOutboxRow(db, row, opts.handlers));
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
): void {
  db.raw.query(INCREMENT_ATTEMPTS_SQL).run(lastError, idempotencyKey);
}

/**
 * Mark a row abandoned. Invoked by the deferred `dome.health` bundle's
 * outbox-answer-handler processor when the user answers `abandon` on
 * the Question raised for `engine.outbox.terminal-failure` (per
 * [[wiki/specs/cli]] §"dome answer" and [[wiki/gotchas/outbox-stuck]]).
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
export function markAbandoned(db: OutboxDb, idempotencyKey: string): void {
  db.raw.query(MARK_ABANDONED_SQL).run(idempotencyKey);
}

/**
 * Re-queue a previously-failed row. Invoked by the deferred
 * `dome.health` bundle's outbox-answer-handler processor when the user
 * answers `retry` on the Question raised for
 * `engine.outbox.terminal-failure` (per [[wiki/specs/cli]] §"dome
 * answer") — typically after the underlying cause has been fixed
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
export function replayFailed(db: OutboxDb, idempotencyKey: string): void {
  db.raw.query(REPLAY_FAILED_SQL).run(idempotencyKey);
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
  return Object.freeze(rows.map(rowToOutboxRow));
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
): Promise<ExternalDispatchResult> {
  if (row.status === "sent") {
    return Object.freeze({
      kind: "already-sent",
      idempotencyKey: row.idempotencyKey,
      externalId: row.externalId ?? "",
    });
  }
  if (row.status === "failed" || row.status === "abandoned") {
    return Object.freeze({
      kind: "skipped",
      idempotencyKey: row.idempotencyKey,
      status: row.status,
    });
  }

  const handler = lookupHandler(handlers, row.capability);
  if (handler === undefined) {
    const msg = `No external handler registered for capability '${row.capability}'.`;
    return recordFailedAttempt(db, row, msg, { terminal: true });
  }

  try {
    const result = await handler({
      capability: row.capability,
      idempotencyKey: row.idempotencyKey,
      payload: row.payload,
      sourceRefs: row.sourceRefs,
      runId: row.runId,
      attempt: row.attempts + 1,
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
    return recordFailedAttempt(db, row, errorMessage(e), { terminal: false });
  }
}

function recordFailedAttempt(
  db: OutboxDb,
  row: OutboxRow,
  lastError: string,
  opts: { readonly terminal: boolean },
): ExternalDispatchResult {
  const attempts = row.attempts + 1;
  incrementAttempts(db, row.idempotencyKey, lastError);
  const terminal = opts.terminal || attempts >= row.maxAttempts;
  if (terminal) {
    markFailed(db, row.idempotencyKey, lastError);
    return Object.freeze({
      kind: "failed",
      idempotencyKey: row.idempotencyKey,
      attempts,
      maxAttempts: row.maxAttempts,
      lastError,
    });
  }
  return Object.freeze({
    kind: "pending",
    idempotencyKey: row.idempotencyKey,
    attempts,
    maxAttempts: row.maxAttempts,
    lastError,
  });
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

/**
 * Row → OutboxRow. Deserializes JSON columns and narrows the `status`
 * string to the closed union. Throws on an unrecognized status (a row
 * corrupted at the SQL boundary — programmer error or external
 * tampering with the db file).
 */
function rowToOutboxRow(row: OutboxRawRow): OutboxRow {
  return Object.freeze({
    id: row.id,
    capability: row.capability,
    idempotencyKey: row.idempotency_key,
    payload: JSON.parse(row.payload_json) as unknown,
    sourceRefs: JSON.parse(row.source_refs) as ReadonlyArray<SourceRef>,
    status: narrowStatus(row.status),
    externalId: row.external_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    enqueuedAt: row.enqueued_at,
    sentAt: row.sent_at,
    lastError: row.last_error,
    runId: row.run_id,
  });
}

/**
 * Narrow the raw `status` string to the closed `OutboxStatus` union.
 * The DDL doesn't carry a CHECK constraint on `status` (v1 simplicity);
 * this function is the read-side fence.
 */
function narrowStatus(s: string): OutboxStatus {
  switch (s) {
    case "pending":
    case "sent":
    case "failed":
    case "abandoned":
      return s;
    default:
      throw new Error(`outbox.dispatch: unknown status '${s}'`);
  }
}
