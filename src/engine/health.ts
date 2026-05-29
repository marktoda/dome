// engine/health: read-only probes for operational recovery surfaces.
//
// Doctor needs one boring substrate read boundary instead of each CLI surface
// hand-assembling outbox, ledger, and quarantine checks. This module performs
// no mutation. Repairs still flow through the engine-asks model: findings
// become questions/answers and answer handlers apply the requested mutation.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { computeAnswersSchemaHash } from "../answers/db";
import type { LedgerDb } from "../ledger/db";
import { computeLedgerSchemaHash } from "../ledger/db";
import { orphanRuns, type RunRow } from "../ledger/runs";
import type { OutboxDb } from "../outbox/db";
import { computeOutboxSchemaHash } from "../outbox/db";
import { queryOutbox, type OutboxRow } from "../outbox/dispatch";
import type { ProjectionDb } from "../projections/db";
import { projectionCacheKeysChanged } from "../projections/db";
import type {
  ProcessorExecutionState,
  ProcessorQuarantineSnapshot,
} from "../processors/execution-state";
import { getAdoptedRef, getCurrentBranch } from "../adopted-ref";
import { currentSha, isAncestor } from "../git";

export const DEFAULT_ORPHAN_RUN_THRESHOLD_MS = 5 * 60 * 1000;
export const DEFAULT_PENDING_OUTBOX_THRESHOLD_MS = 30 * 60 * 1000;

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
    }
  | {
      readonly code: "outbox.pending-stuck";
      readonly severity: "warning";
      readonly subject: "outbox";
      readonly id: string;
      readonly message: string;
      readonly recovery: string;
      readonly outbox: Pick<
        OutboxRow,
        "id" | "capability" | "idempotencyKey" | "attempts" | "nextAttemptAt"
      >;
    }
  | {
      readonly code: "projection.cache-key-drift";
      readonly severity: "warning";
      readonly subject: "projection";
      readonly id: string;
      readonly message: string;
      readonly recovery: string;
    }
  | {
      readonly code: "adopted-ref.diverged";
      readonly severity: "error";
      readonly subject: "git";
      readonly id: string;
      readonly message: string;
      readonly recovery: string;
      readonly git: {
        readonly branch: string;
        readonly head: string;
        readonly adopted: string;
      };
    }
  | {
      readonly code: "instructions.drift";
      readonly severity: "warning";
      readonly subject: "instructions";
      readonly id: string;
      readonly message: string;
      readonly recovery: string;
    }
  | {
      readonly code: "operational.schema-mismatch";
      readonly severity: "error";
      readonly subject: "storage";
      readonly id: string;
      readonly message: string;
      readonly recovery: string;
      readonly storage: {
        readonly database: "answers" | "outbox" | "ledger";
        readonly path: string;
        readonly stored: string | null;
        readonly expected: string;
      };
    };

export type HealthSummary = {
  readonly findingCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly failedOutbox: number;
  readonly stuckPendingOutbox: number;
  readonly orphanRuns: number;
  readonly quarantinedProcessors: number;
  readonly projectionCacheDrift: number;
  readonly adoptedRefDivergence: number;
  readonly instructionDrift: number;
  readonly operationalSchemaMismatch: number;
};

export type HealthReport = {
  readonly status: "ok" | "unhealthy";
  readonly generatedAt: string;
  readonly summary: HealthSummary;
  readonly findings: ReadonlyArray<HealthFinding>;
};

export async function collectHealthReport(opts: {
  readonly vaultPath: string;
  readonly projection: ProjectionDb;
  readonly ledger: LedgerDb;
  readonly outbox: OutboxDb;
  readonly executionState: ProcessorExecutionState;
  readonly extensions: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
  }>;
  readonly processorVersions: ReadonlyArray<{
    readonly id: string;
    readonly version: string;
  }>;
  readonly now?: Date;
  readonly orphanRunThresholdMs?: number;
  readonly pendingOutboxThresholdMs?: number;
}): Promise<HealthReport> {
  const now = opts.now ?? new Date();
  const orphanRunThresholdMs =
    opts.orphanRunThresholdMs ?? DEFAULT_ORPHAN_RUN_THRESHOLD_MS;
  const pendingOutboxThresholdMs =
    opts.pendingOutboxThresholdMs ?? DEFAULT_PENDING_OUTBOX_THRESHOLD_MS;
  const failedOutbox = queryOutbox(opts.outbox, { status: "failed" });
  const stuckPendingOutbox = queryOutbox(opts.outbox, { status: "pending" })
    .filter((row) => isStuckPendingOutbox(row, now, pendingOutboxThresholdMs));
  const orphaned = orphanRuns(opts.ledger, orphanRunThresholdMs, now);
  const quarantined = opts.executionState.quarantines();
  const projectionDrift = projectionCacheKeysChanged(opts.projection, {
    extensionSet: opts.extensions,
    processorVersions: opts.processorVersions,
  })
    ? [projectionCacheDriftFinding()]
    : [];
  const adoptedDivergence = await adoptedRefDivergenceFinding(opts.vaultPath);
  const instructionDrift = instructionDriftFindings(opts.vaultPath);
  const storageSchema = collectOperationalSchemaFindings(opts.vaultPath);

  const findings: HealthFinding[] = [
    ...storageSchema,
    ...failedOutbox.map(outboxFinding),
    ...stuckPendingOutbox.map(stuckPendingOutboxFinding),
    ...orphaned.map(orphanFinding),
    ...quarantined.map(quarantineFinding),
    ...projectionDrift,
    ...(adoptedDivergence === null ? [] : [adoptedDivergence]),
    ...instructionDrift,
  ];
  return buildHealthReport(findings, now);
}

export function collectOperationalSchemaReport(opts: {
  readonly vaultPath: string;
  readonly now?: Date;
}): HealthReport {
  return buildHealthReport(
    collectOperationalSchemaFindings(opts.vaultPath),
    opts.now ?? new Date(),
  );
}

function buildHealthReport(
  findings: ReadonlyArray<HealthFinding>,
  now: Date,
): HealthReport {
  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  const count = (code: HealthFinding["code"]): number =>
    findings.filter((f) => f.code === code).length;

  return Object.freeze({
    status: findings.length === 0 ? "ok" : "unhealthy",
    generatedAt: now.toISOString(),
    summary: Object.freeze({
      findingCount: findings.length,
      errorCount,
      warningCount,
      failedOutbox: count("outbox.failed"),
      stuckPendingOutbox: count("outbox.pending-stuck"),
      orphanRuns: count("run.orphan"),
      quarantinedProcessors: count("processor.quarantined"),
      projectionCacheDrift: count("projection.cache-key-drift"),
      adoptedRefDivergence: count("adopted-ref.diverged"),
      instructionDrift: count("instructions.drift"),
      operationalSchemaMismatch: count("operational.schema-mismatch"),
    }),
    findings: Object.freeze([...findings]),
  });
}

function isStuckPendingOutbox(
  row: OutboxRow,
  now: Date,
  thresholdMs: number,
): boolean {
  const enqueued = Date.parse(row.enqueuedAt);
  const nextAttempt = Date.parse(row.nextAttemptAt);
  if (!Number.isFinite(enqueued) || !Number.isFinite(nextAttempt)) return true;
  return nextAttempt <= now.getTime() && now.getTime() - enqueued >= thresholdMs;
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
      "Inspect with `dome inspect outbox`; run `dome sync` or `dome serve` " +
      "with dome.health enabled to raise a retry/abandon question, then " +
      "answer it with `dome answer`.",
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

function stuckPendingOutboxFinding(row: OutboxRow): HealthFinding {
  return Object.freeze({
    code: "outbox.pending-stuck" as const,
    severity: "warning" as const,
    subject: "outbox" as const,
    id: row.idempotencyKey,
    message:
      `Outbox row ${row.id} (${row.capability}) is pending and due ` +
      `for retry since ${row.nextAttemptAt}.`,
    recovery:
      "Run `dome sync` or `dome serve` to drain due outbox work; if it " +
      "keeps returning, inspect with `dome inspect outbox`.",
    outbox: Object.freeze({
      id: row.id,
      capability: row.capability,
      idempotencyKey: row.idempotencyKey,
      attempts: row.attempts,
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
      "Inspect with `dome inspect runs`; orphan-run recovery should route " +
      "through `dome answer` when run-recovery handlers ship.",
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

function projectionCacheDriftFinding(): HealthFinding {
  return Object.freeze({
    code: "projection.cache-key-drift" as const,
    severity: "warning" as const,
    subject: "projection" as const,
    id: "projection-cache-key",
    message:
      "Projection cache keys differ from the loaded extension/processor set.",
    recovery:
      "Run `dome rebuild` or `dome sync`; the host normally rebuilds this " +
      "automatically before operational work.",
  });
}

async function adoptedRefDivergenceFinding(
  vaultPath: string,
): Promise<HealthFinding | null> {
  const branch = await getCurrentBranch(vaultPath);
  if (branch === null) return null;
  let head: string | null;
  try {
    head = await currentSha(vaultPath);
  } catch {
    return null;
  }
  if (head === null) return null;
  const adopted = await getAdoptedRef(vaultPath, branch);
  if (adopted === null || adopted === head) return null;
  const ok = await isAncestor({
    path: vaultPath,
    ancestor: adopted,
    descendant: head,
  });
  if (ok) return null;
  return Object.freeze({
    code: "adopted-ref.diverged" as const,
    severity: "error" as const,
    subject: "git" as const,
    id: `refs/dome/adopted/${branch}`,
    message:
      `Adopted ref for ${branch} (${adopted.slice(0, 7)}) is not an ` +
      `ancestor of HEAD (${head.slice(0, 7)}).`,
    recovery:
      "Inspect git history before syncing; this usually means the branch " +
      "was rebased, reset, or force-updated.",
    git: Object.freeze({ branch, head, adopted }),
  });
}

function instructionDriftFindings(vaultPath: string): ReadonlyArray<HealthFinding> {
  if (!existsSync(join(vaultPath, ".dome", "config.yaml"))) {
    return Object.freeze([]);
  }
  const findings: HealthFinding[] = [];
  const agentsPath = join(vaultPath, "AGENTS.md");
  const claudePath = join(vaultPath, "CLAUDE.md");
  if (!existsSync(agentsPath)) {
    findings.push(instructionDriftFinding("AGENTS.md", "AGENTS.md is missing."));
  } else {
    const agents = readFileSync(agentsPath, "utf8");
    if (!agents.includes("<!-- BEGIN user-prose -->")) {
      findings.push(
        instructionDriftFinding(
          "AGENTS.md",
          "AGENTS.md is missing the managed user-prose delimiter.",
        ),
      );
    }
  }
  if (!existsSync(claudePath)) {
    findings.push(instructionDriftFinding("CLAUDE.md", "CLAUDE.md is missing."));
  } else {
    const claude = readFileSync(claudePath, "utf8");
    if (!claude.includes("@AGENTS.md")) {
      findings.push(
        instructionDriftFinding(
          "CLAUDE.md",
          "CLAUDE.md does not import AGENTS.md.",
        ),
      );
    }
  }
  return Object.freeze(findings);
}

function instructionDriftFinding(id: string, message: string): HealthFinding {
  return Object.freeze({
    code: "instructions.drift" as const,
    severity: "warning" as const,
    subject: "instructions" as const,
    id,
    message,
    recovery:
      "Re-run `dome init` to restore missing orientation files without " +
      "overwriting user prose.",
  });
}

function collectOperationalSchemaFindings(
  vaultPath: string,
): ReadonlyArray<HealthFinding> {
  const statePath = join(vaultPath, ".dome", "state");
  return Object.freeze(
    [
      operationalSchemaFinding({
        database: "answers",
        path: join(statePath, "answers.db"),
        table: "answers_meta",
        expected: computeAnswersSchemaHash(),
      }),
      operationalSchemaFinding({
        database: "outbox",
        path: join(statePath, "outbox.db"),
        table: "outbox_meta",
        expected: computeOutboxSchemaHash(),
      }),
      operationalSchemaFinding({
        database: "ledger",
        path: join(statePath, "runs.db"),
        table: "ledger_meta",
        expected: computeLedgerSchemaHash(),
      }),
    ].filter((finding): finding is HealthFinding => finding !== null),
  );
}

function operationalSchemaFinding(opts: {
  readonly database: "answers" | "outbox" | "ledger";
  readonly path: string;
  readonly table: string;
  readonly expected: string;
}): HealthFinding | null {
  if (!existsSync(opts.path)) return null;
  const stored = readOperationalSchemaHash(opts.path, opts.table);
  if (stored === opts.expected) return null;
  return Object.freeze({
    code: "operational.schema-mismatch" as const,
    severity: "error" as const,
    subject: "storage" as const,
    id: `${opts.database}.schema`,
    message:
      `${opts.database}.db schema ${
        stored === null ? "could not be verified" : `hash ${stored}`
      }; expected ${opts.expected}.`,
    recovery:
      "Do not delete operational state. Keep the file intact and run a " +
      "compatible Dome version or an explicit migration.",
    storage: Object.freeze({
      database: opts.database,
      path: opts.path,
      stored,
      expected: opts.expected,
    }),
  });
}

function readOperationalSchemaHash(path: string, table: string): string | null {
  let db: Database;
  try {
    db = new Database(path, { readonly: true, create: false });
  } catch {
    return null;
  }
  try {
    const tableExists = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table);
    if (tableExists === null) return null;
    const row = db
      .query<{ schema_hash: string }, []>(
        `SELECT schema_hash FROM ${table} LIMIT 1`,
      )
      .get();
    return row?.schema_hash ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
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
      "Inspect recent runs; reset/retry should route through `dome answer` " +
      "when quarantine recovery handlers ship.",
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
