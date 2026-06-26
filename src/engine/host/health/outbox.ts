// engine/host/health/outbox: outbox failure + stuck-pending + recurring-failure
// probes, the unreadable-question backlog probe, and their finding mappers.
import type { OutboxRow } from "../../../outbox/dispatch";
import { DEFAULT_RECURRING_OUTBOX_FAILURE_THRESHOLD_MS } from "./types";
import type { HealthFinding } from "./types";

export function isStuckPendingOutbox(
  row: OutboxRow,
  now: Date,
  thresholdMs: number,
): boolean {
  const enqueued = Date.parse(row.enqueuedAt);
  const nextAttempt = Date.parse(row.nextAttemptAt);
  if (!Number.isFinite(enqueued) || !Number.isFinite(nextAttempt)) return true;
  return nextAttempt <= now.getTime() && now.getTime() - enqueued >= thresholdMs;
}

export function outboxFinding(row: OutboxRow): HealthFinding {
  return Object.freeze({
    code: "outbox.failed" as const,
    severity: "error" as const,
    subject: "outbox" as const,
    id: row.idempotencyKey,
    message:
      `Outbox row ${row.id} (${row.capability}) failed after ` +
      `${row.attempts}/${row.maxAttempts} attempt(s).`,
    recovery:
      "Run `dome sync --json` or keep `dome serve` running with dome.health " +
      "enabled to raise a retry/abandon question, then resolve it with " +
      "`dome resolve`. Use `dome inspect outbox` only for row-level detail.",
    outbox: Object.freeze({
      id: row.id,
      capability: row.capability,
      idempotencyKey: row.idempotencyKey,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      lastError: row.lastError,
      nextAttemptAt: row.nextAttemptAt,
    }),
  });
}

export function stuckPendingOutboxFinding(row: OutboxRow): HealthFinding {
  return Object.freeze({
    code: "outbox.pending-stuck" as const,
    severity: "warning" as const,
    subject: "outbox" as const,
    id: row.idempotencyKey,
    message:
      `Outbox row ${row.id} (${row.capability}) is pending and due ` +
      `for retry since ${row.nextAttemptAt}.`,
    recovery:
      "Run `dome sync --json` or keep `dome serve` running to drain due " +
      "outbox work; if it keeps returning, use `dome check --json` for the " +
      "next action or `dome inspect outbox` for row-level detail.",
    outbox: Object.freeze({
      id: row.id,
      capability: row.capability,
      idempotencyKey: row.idempotencyKey,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt,
    }),
  });
}

/**
 * Recurring-outbox-failure findings: a `failed` row (always past max attempts,
 * since the dispatcher only marks `failed` once `attempts >= maxAttempts`) that
 * has stayed failed well beyond its retry budget is a fetcher/command that
 * keeps re-failing on re-emit, not a fresh transient. The observable is enqueue
 * age: the row resets `attempts`/`status` on each recovery retry but never
 * `enqueued_at`, so a row whose `enqueuedAt` is older than the recurrence
 * window has survived its retry backoff plus a round of the minute-cadence
 * dome.health recovery loop and is still failing — that is the
 * fix-the-command signal. A freshly-failed row stays the per-row
 * `outbox.failed` retry-or-abandon question (the normal transient path).
 */
export function recurringOutboxFailureFindings(opts: {
  readonly failedOutbox: ReadonlyArray<OutboxRow>;
  readonly now: Date;
  readonly thresholdMs?: number;
}): ReadonlyArray<HealthFinding> {
  const thresholdMs =
    opts.thresholdMs ?? DEFAULT_RECURRING_OUTBOX_FAILURE_THRESHOLD_MS;
  const findings: HealthFinding[] = [];
  for (const row of opts.failedOutbox) {
    const enqueued = Date.parse(row.enqueuedAt);
    // An unparseable timestamp is treated as recurring — a row we cannot age
    // is not a fresh transient we can vouch for.
    const recurring =
      !Number.isFinite(enqueued) ||
      opts.now.getTime() - enqueued >= thresholdMs;
    if (!recurring) continue;
    findings.push(
      Object.freeze({
        code: "outbox.recurring-failure" as const,
        severity: "error" as const,
        subject: "outbox" as const,
        id: row.idempotencyKey,
        message:
          `Outbox row ${row.id} (${row.capability}) fails every run — it has ` +
          `been in the failed state since ${row.enqueuedAt} despite the ` +
          `recovery loop, so retrying will not help; the command/fetcher ` +
          `behind it needs fixing` +
          (row.lastError === null ? "." : ` (last error: ${row.lastError}).`),
        recovery:
          "This is not a transient blip: fix the failing command/fetcher " +
          "(for a dome.sources feed, run its fetch command manually from the " +
          "vault root to reproduce, then repair the script or its config in " +
          ".dome/config.yaml), or abandon the row via the dome.health " +
          "outbox-recovery question if the action is no longer wanted. Use " +
          "`dome inspect outbox` for row-level detail.",
        outbox: Object.freeze({
          id: row.id,
          capability: row.capability,
          idempotencyKey: row.idempotencyKey,
          attempts: row.attempts,
          maxAttempts: row.maxAttempts,
          lastError: row.lastError,
          enqueuedAt: row.enqueuedAt,
        }),
      }),
    );
  }
  return Object.freeze(findings);
}

/**
 * The unreadable-question-backlog finding: when `countUnrehydratableQuestions`
 * (Task 1's primitive) reports N > 0 poison/older-build rows that the
 * failure-isolating read skips, raise ONE finding so the backlog is visible on
 * the doctor/check surface instead of being a stderr-only skip signal. Rebuild
 * re-derives questions from adopted markdown and reapplies durable answers, so
 * it is the repair.
 */
export function unreadableQuestionBacklogFindings(opts: {
  readonly unrehydratableCount: number;
}): ReadonlyArray<HealthFinding> {
  if (opts.unrehydratableCount <= 0) return Object.freeze([]);
  return Object.freeze([
    Object.freeze({
      code: "questions.unreadable-backlog" as const,
      severity: "warning" as const,
      subject: "questions" as const,
      id: "unreadable_questions" as const,
      message:
        `${opts.unrehydratableCount} question row(s) cannot be read ` +
        "(their stored metadata fails the current strict schema — typically " +
        "rows written by an older build). They are skipped on read so the " +
        "operational tick still completes and other questions auto-resolve, " +
        "but they cannot be surfaced or resolved until repaired.",
      recovery:
        "Run `dome rebuild` to re-derive question rows from adopted markdown " +
        "(durable answers are reapplied from answers.db); the unreadable " +
        "rows are regenerated in the current schema.",
      questions: Object.freeze({ unreadableCount: opts.unrehydratableCount }),
    }),
  ]);
}

/**
 * Recurring-processor-timeout findings: group recent `timed_out` runs by
 * processor; a processor at or above the threshold gets ONE finding ("raise its
 * timeout or scope it") rather than the silent serve.log loop. Cheap — derived
 * from a bounded `queryRunSummaries(status: "timed_out")` scan the caller
 * supplies; no extra aggregation query.
 */
