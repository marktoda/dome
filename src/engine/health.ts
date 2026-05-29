// engine/health: read-only probes for operational recovery surfaces.
//
// Doctor needs one boring substrate read boundary instead of each CLI surface
// hand-assembling outbox, ledger, and quarantine checks. This module performs
// no mutation. Repairs still flow through the engine-asks model: findings
// become questions/answers and answer handlers apply the requested mutation.

import type { LedgerDb } from "../ledger/db";
import { orphanRuns, type RunRow } from "../ledger/runs";
import type { OutboxDb } from "../outbox/db";
import { queryOutbox, type OutboxRow } from "../outbox/dispatch";
import type {
  ProcessorExecutionState,
  ProcessorQuarantineSnapshot,
} from "../processors/execution-state";

export const DEFAULT_ORPHAN_RUN_THRESHOLD_MS = 5 * 60 * 1000;

export type HealthFinding =
  | {
      readonly code: "outbox.failed";
      readonly severity: "error";
      readonly subject: "outbox";
      readonly id: string;
      readonly message: string;
      readonly recovery: string;
      readonly outbox: Pick<
        OutboxRow,
        | "id"
        | "capability"
        | "idempotencyKey"
        | "attempts"
        | "maxAttempts"
        | "lastError"
        | "nextAttemptAt"
      >;
    }
  | {
      readonly code: "run.orphan";
      readonly severity: "error";
      readonly subject: "runs";
      readonly id: string;
      readonly message: string;
      readonly recovery: string;
      readonly run: Pick<
        RunRow,
        | "id"
        | "processorId"
        | "processorVersion"
        | "phase"
        | "triggerKind"
        | "startedAt"
      >;
    }
  | {
      readonly code: "processor.quarantined";
      readonly severity: "warning";
      readonly subject: "quarantine";
      readonly id: string;
      readonly message: string;
      readonly recovery: string;
      readonly quarantine: {
        readonly phase: string;
        readonly processorId: string;
        readonly processorVersion: string;
        readonly triggerHash: string;
        readonly consecutiveRetryableFailures: number;
        readonly quarantinedAt: string;
        readonly reason: string;
      };
    };

export type HealthSummary = {
  readonly findingCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly failedOutbox: number;
  readonly orphanRuns: number;
  readonly quarantinedProcessors: number;
};

export type HealthReport = {
  readonly status: "ok" | "unhealthy";
  readonly generatedAt: string;
  readonly summary: HealthSummary;
  readonly findings: ReadonlyArray<HealthFinding>;
};

export function collectHealthReport(opts: {
  readonly ledger: LedgerDb;
  readonly outbox: OutboxDb;
  readonly executionState: ProcessorExecutionState;
  readonly now?: Date;
  readonly orphanRunThresholdMs?: number;
}): HealthReport {
  const now = opts.now ?? new Date();
  const orphanRunThresholdMs =
    opts.orphanRunThresholdMs ?? DEFAULT_ORPHAN_RUN_THRESHOLD_MS;
  const failedOutbox = queryOutbox(opts.outbox, { status: "failed" });
  const orphaned = orphanRuns(opts.ledger, orphanRunThresholdMs, now);
  const quarantined = opts.executionState.quarantines();

  const findings: HealthFinding[] = [
    ...failedOutbox.map(outboxFinding),
    ...orphaned.map(orphanFinding),
    ...quarantined.map(quarantineFinding),
  ];
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;

  return Object.freeze({
    status: findings.length === 0 ? "ok" : "unhealthy",
    generatedAt: now.toISOString(),
    summary: Object.freeze({
      findingCount: findings.length,
      errorCount,
      warningCount,
      failedOutbox: failedOutbox.length,
      orphanRuns: orphaned.length,
      quarantinedProcessors: quarantined.length,
    }),
    findings: Object.freeze(findings),
  });
}

function outboxFinding(row: OutboxRow): HealthFinding {
  return Object.freeze({
    code: "outbox.failed" as const,
    severity: "error" as const,
    subject: "outbox" as const,
    id: row.idempotencyKey,
    message:
      `Outbox row ${row.id} (${row.capability}) failed after ` +
      `${row.attempts}/${row.maxAttempts} attempt(s).`,
    recovery:
      "Inspect with `dome inspect outbox`; recovery will route through " +
      "`dome answer` when dome.health answer handlers ship.",
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

function orphanFinding(row: RunRow): HealthFinding {
  return Object.freeze({
    code: "run.orphan" as const,
    severity: "error" as const,
    subject: "runs" as const,
    id: row.id,
    message:
      `Run ${row.id} for ${row.processorId} is still running from ` +
      `${row.startedAt}.`,
    recovery:
      "Inspect with `dome inspect runs`; recovery will route through " +
      "`dome answer` when dome.health answer handlers ship.",
    run: Object.freeze({
      id: row.id,
      processorId: row.processorId,
      processorVersion: row.processorVersion,
      phase: row.phase,
      triggerKind: row.triggerKind,
      startedAt: row.startedAt,
    }),
  });
}

function quarantineFinding(row: ProcessorQuarantineSnapshot): HealthFinding {
  return Object.freeze({
    code: "processor.quarantined" as const,
    severity: "warning" as const,
    subject: "quarantine" as const,
    id: [
      row.key.phase,
      row.key.processorId,
      row.key.processorVersion,
      row.key.triggerHash.slice(0, 12),
    ].join(":"),
    message:
      `Processor ${row.key.processorId} is quarantined for trigger ` +
      `${row.key.triggerHash.slice(0, 12)} after ` +
      `${row.consecutiveRetryableFailures} retryable failure(s).`,
    recovery:
      "Inspect recent runs; reset/retry will route through `dome answer` " +
      "when dome.health answer handlers ship.",
    quarantine: Object.freeze({
      phase: row.key.phase,
      processorId: row.key.processorId,
      processorVersion: row.key.processorVersion,
      triggerHash: row.key.triggerHash,
      consecutiveRetryableFailures: row.consecutiveRetryableFailures,
      quarantinedAt: row.quarantinedAt.toISOString(),
      reason: row.reason,
    }),
  });
}
