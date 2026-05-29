// projection-jobs: per-table accessor for JobEffect rows. Owns the JobEffect
// → `scheduled_jobs` row serialization, the next-eligible-job query, the
// atomic claim operation, and the status-transition helpers used by the
// engine's job runner.
//
// Normative references:
//   - docs/wiki/specs/projection-store.md §"Tables — scheduled_jobs"
//     (column shape + UNIQUE (idempotency_key) + status enum)
//   - docs/wiki/specs/effects.md §"JobEffect" (runAfter optional; absent →
//     "runs as soon as the queue permits")
//
// House-style notes (matches src/projections/db.ts, src/projections/facts.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - JSON column `input_json` serialized via `JSON.stringify`; symmetric
//     `JSON.parse` on read.
//   - INSERT uses `INSERT OR IGNORE` to honor the `idempotency_key UNIQUE`
//     constraint: a re-emission with the same key is a no-op.
//   - `nextEligibleJob` exposes the typed row (not a JobEffect) because the
//     caller (engine runner) needs the `id`, `attempts`, `status`, etc.
//     fields that aren't part of the JobEffect shape.
//   - `claimNextEligibleJob` is the runner-facing boundary: it atomically
//     transitions one due row from pending → running and returns the claimed
//     post-transition row. The engine should not treat a selected row as
//     runnable until that claim succeeds.
//   - Status transitions are explicit one-liners (`markJobRunning` /
//     `markJobPending` / `markJobSucceeded` / `markJobFailed`) rather than
//     a generic `setStatus` — keeps the call sites in the engine runner self-
//     describing and bounds the legal transitions per the spec.

import type { JobEffect } from "../core/effect";
import type { ProjectionDb } from "./db";

// ----- Public types ---------------------------------------------------------

export type JobInsertOpts = {
  /**
   * The JobEffect to enqueue. `runAfter`, when absent, defaults to "now"
   * (the spec's "runs as soon as the queue permits" semantic).
   */
  readonly effect: JobEffect;
  /**
   * The processor that emitted the job. The current table stores only the
   * target processor (`effect.processorId`); this value is kept at the sink
   * boundary for future audit expansion.
   */
  readonly processorId: string;
};

export type JobStatus = "pending" | "running" | "succeeded" | "failed";

export type ScheduledJobRow = {
  readonly id: number;
  readonly processorId: string;
  readonly input: unknown;
  readonly runAfter: string;
  readonly idempotencyKey: string;
  readonly maxAttempts: number;
  readonly attempts: number;
  readonly status: JobStatus;
  readonly enqueuedAt: string;
  readonly completedAt: string | null;
};

// ----- SQL ------------------------------------------------------------------

const ENQUEUE_JOB_SQL = `
INSERT OR IGNORE INTO scheduled_jobs (
  processor_id, input_json, run_after, idempotency_key,
  max_attempts, attempts, status, enqueued_at, completed_at
) VALUES (?, ?, ?, ?, ?, 0, 'pending', ?, NULL)
`.trim();

const NEXT_ELIGIBLE_JOB_SQL = `
SELECT id, processor_id, input_json, run_after, idempotency_key,
       max_attempts, attempts, status, enqueued_at, completed_at
FROM scheduled_jobs
WHERE status = 'pending' AND run_after <= ?
ORDER BY run_after, id
LIMIT 1
`.trim();

const MARK_RUNNING_SQL = `
UPDATE scheduled_jobs
SET status = 'running', attempts = attempts + 1
WHERE id = ? AND status = 'pending'
`.trim();

const CLAIM_NEXT_ELIGIBLE_JOB_SQL = `
UPDATE scheduled_jobs
SET status = 'running', attempts = attempts + 1
WHERE id = (
  SELECT id
  FROM scheduled_jobs
  WHERE status = 'pending' AND run_after <= ?
  ORDER BY run_after, id
  LIMIT 1
)
RETURNING id, processor_id, input_json, run_after, idempotency_key,
          max_attempts, attempts, status, enqueued_at, completed_at
`.trim();

const MARK_PENDING_SQL = `
UPDATE scheduled_jobs
SET status = 'pending', run_after = ?, completed_at = NULL
WHERE id = ? AND status = 'running'
`.trim();

const RELEASE_CLAIMED_SQL = `
UPDATE scheduled_jobs
SET status = 'pending',
    attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
    run_after = ?,
    completed_at = NULL
WHERE id = ? AND status = 'running'
`.trim();

const MARK_SUCCEEDED_SQL = `
UPDATE scheduled_jobs
SET status = 'succeeded', completed_at = ?
WHERE id = ? AND status = 'running'
`.trim();

const MARK_FAILED_SQL = `
UPDATE scheduled_jobs
SET status = 'failed', completed_at = ?
WHERE id = ? AND status = 'running'
`.trim();

// ----- Row shape ------------------------------------------------------------

type JobRow = {
  readonly id: number;
  readonly processor_id: string;
  readonly input_json: string;
  readonly run_after: string;
  readonly idempotency_key: string;
  readonly max_attempts: number;
  readonly attempts: number;
  readonly status: string;
  readonly enqueued_at: string;
  readonly completed_at: string | null;
};

// ----- Defaults -------------------------------------------------------------

// Per spec §"Tables — scheduled_jobs", `max_attempts INTEGER NOT NULL
// DEFAULT 3`. We mirror that default at the application layer so callers
// always supply an explicit value to SQLite (defensive against schema-DDL
// drift between the table definition and this accessor).
const DEFAULT_MAX_ATTEMPTS = 3;

// ----- Public functions -----------------------------------------------------

/**
 * Enqueue a JobEffect. Honors the `idempotency_key UNIQUE` constraint via
 * `INSERT OR IGNORE` — a re-emission with the same key is a no-op (per the
 * spec's "JobEffect... idempotencyKey: dedup key" semantic).
 *
 * `runAfter` defaults to `now.toISOString()` when the effect omits it (per
 * spec: "if absent, runs as soon as the queue permits"). `maxAttempts`
 * defaults to 3 (matching the table's DEFAULT clause).
 *
 * Throws on SQLite-level failure (disk full).
 */
export function enqueueJob(db: ProjectionDb, opts: JobInsertOpts): void {
  const { effect } = opts;
  const now = new Date().toISOString();
  const runAfter = effect.runAfter ?? now;
  const maxAttempts = effect.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  db.raw.query(ENQUEUE_JOB_SQL).run(
    effect.processorId,
    JSON.stringify(effect.input ?? null),
    runAfter,
    effect.idempotencyKey,
    maxAttempts,
    now,
  );
}

/**
 * Return the next pending job whose `run_after <= now`, ordered by
 * `(run_after, id)`. Returns `null` when no job is eligible.
 *
 * Caller transitions the row's status manually via `markJobRunning` →
 * (`markJobSucceeded` | `markJobFailed`). This split keeps the SQL boundary
 * pure (no business decisions about retry / backoff live here).
 */
export function nextEligibleJob(
  db: ProjectionDb,
  now: Date,
): ScheduledJobRow | null {
  const rows = db.raw
    .query<JobRow, [string]>(NEXT_ELIGIBLE_JOB_SQL)
    .all(now.toISOString());
  const r = rows[0];
  if (r === undefined) return null;
  return rowToScheduledJob(r);
}

/**
 * Atomically claim the next due pending job. The returned row is already in
 * `status: "running"` and has `attempts` incremented for the attempt the
 * caller is about to execute. Returns `null` when no pending due job exists.
 *
 * This is the engine runner's preferred boundary. `nextEligibleJob` remains a
 * read-only query helper for inspection/tests; production drains should claim
 * before invoking target processor code.
 */
export function claimNextEligibleJob(
  db: ProjectionDb,
  now: Date,
): ScheduledJobRow | null {
  const row = db.raw
    .query<JobRow, [string]>(CLAIM_NEXT_ELIGIBLE_JOB_SQL)
    .get(now.toISOString());
  return row === null ? null : rowToScheduledJob(row);
}

/**
 * Transition a `pending` row to `running` and bump `attempts`. No-op if the
 * row is already in another status (concurrent runner picked it up).
 */
export function markJobRunning(db: ProjectionDb, id: number): void {
  db.raw.query(MARK_RUNNING_SQL).run(id);
}

/**
 * Transition a `running` row back to `pending` for a later retry. Attempts
 * are not changed here — `markJobRunning` already bumped the counter for
 * the attempt that just failed.
 */
export function markJobPending(
  db: ProjectionDb,
  id: number,
  runAfter: Date,
): void {
  db.raw.query(MARK_PENDING_SQL).run(runAfter.toISOString(), id);
}

/**
 * Return a claimed `running` row to `pending` without consuming retry budget.
 * Used when host shutdown cancels an in-flight job dispatch: the claim itself
 * bumped attempts, but no durable attempt should be charged for cancelled work.
 */
export function releaseClaimedJob(
  db: ProjectionDb,
  id: number,
  runAfter: Date,
): void {
  db.raw.query(RELEASE_CLAIMED_SQL).run(runAfter.toISOString(), id);
}

/**
 * Transition a `running` row to `succeeded` with the given completion time.
 * No-op if the row is not in `running` (defense against double-completion).
 */
export function markJobSucceeded(
  db: ProjectionDb,
  id: number,
  completedAt: Date,
): void {
  db.raw.query(MARK_SUCCEEDED_SQL).run(completedAt.toISOString(), id);
}

/**
 * Transition a `running` row to `failed` with the given completion time.
 * No-op if the row is not in `running` (defense against double-completion).
 */
export function markJobFailed(
  db: ProjectionDb,
  id: number,
  completedAt: Date,
): void {
  db.raw.query(MARK_FAILED_SQL).run(completedAt.toISOString(), id);
}

// ----- internals ------------------------------------------------------------

function rowToScheduledJob(row: JobRow): ScheduledJobRow {
  return Object.freeze({
    id: row.id,
    processorId: row.processor_id,
    input: JSON.parse(row.input_json) as unknown,
    runAfter: row.run_after,
    idempotencyKey: row.idempotency_key,
    maxAttempts: row.max_attempts,
    attempts: row.attempts,
    status: row.status as JobStatus,
    enqueuedAt: row.enqueued_at,
    completedAt: row.completed_at,
  });
}
