// engine/host/health/operational: run-health probes (recurring timeouts,
// orphans, latest-problem, quarantine), projection cache drift, adopted-ref
// divergence, instruction drift, and operational-schema mismatch.
import { existsSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY,
  computeAnswersSchemaHash,
} from "../../../answers/db";
import { computeLedgerSchemaHash } from "../../../ledger/db";
import {
  computeOutboxSchemaHash,
  OUTBOX_SCHEMA_HASH_BEFORE_NEXT_ATTEMPT_AT,
} from "../../../outbox/db";
import {
  type RunRow,
  type RunSummaryRow,
} from "../../../ledger/runs";
import { getAdoptedRef, getCurrentBranch } from "../../../adopted-ref";
import { countCommitsOnlyIn, currentSha, isAncestor } from "../../../git";
import { compareStrings } from "../../../core/compare";
import type {
  ProcessorQuarantineSnapshot,
} from "../../../processors/execution-state";
import {
  DEFAULT_RECURRING_TIMEOUT_THRESHOLD,
  SQLITE_BUSY_TIMEOUT_MS,
} from "./types";
import type { HealthFinding } from "./types";

export function recurringTimeoutFindings(opts: {
  readonly recentTimedOutRuns: ReadonlyArray<RunSummaryRow>;
  readonly threshold?: number;
}): ReadonlyArray<HealthFinding> {
  const threshold = opts.threshold ?? DEFAULT_RECURRING_TIMEOUT_THRESHOLD;
  const byProcessor = new Map<
    string,
    { count: number; lastTimedOutAt: string | null }
  >();
  for (const run of opts.recentTimedOutRuns) {
    if (run.status !== "timed_out") continue;
    const entry = byProcessor.get(run.processorId) ?? {
      count: 0,
      lastTimedOutAt: null,
    };
    entry.count += 1;
    // queryRunSummaries returns newest-first, so the first seen is the latest.
    if (entry.lastTimedOutAt === null) {
      entry.lastTimedOutAt = run.finishedAt ?? run.startedAt;
    }
    byProcessor.set(run.processorId, entry);
  }
  const findings: HealthFinding[] = [];
  for (const processorId of [...byProcessor.keys()].sort(compareStrings)) {
    const entry = byProcessor.get(processorId);
    if (entry === undefined || entry.count < threshold) continue;
    findings.push(
      Object.freeze({
        code: "run.recurring-timeout" as const,
        severity: "warning" as const,
        subject: "runs" as const,
        id: processorId,
        message:
          `Processor ${processorId} has timed out ${entry.count} time(s) ` +
          "recently — its runs repeatedly exceed their execution timeout, " +
          "which silently blocks the work they do (adoption-phase timeouts " +
          "block trusted-state advance).",
        recovery:
          "Raise the processor's execution.timeoutMs in its bundle manifest " +
          "(adoption deterministic timeouts are bounded by the adoption " +
          "ceiling) or scope its work to the changed paths instead of the " +
          "whole vault. Use `dome inspect runs --status timed_out` for detail.",
        run: Object.freeze({
          processorId,
          timedOutCount: entry.count,
          lastTimedOutAt: entry.lastTimedOutAt,
        }),
      }),
    );
  }
  return Object.freeze(findings);
}

export function orphanFinding(row: RunRow): HealthFinding {
  return Object.freeze({
    code: "run.orphan" as const,
    severity: "error" as const,
    subject: "runs" as const,
    id: row.id,
    message:
      `Run ${row.id} for ${row.processorId} is still running from ` +
      `${row.startedAt}.`,
    recovery:
      "Run `dome sync --json` or keep `dome serve` running to raise the " +
      "`dome.health` orphan-run recovery question, then resolve it with " +
      "`dome resolve <id> fail`. Use `dome inspect runs` only for row-level " +
      "detail.",
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

export function latestProblemRunFinding(row: RunRow): HealthFinding {
  return Object.freeze({
    code: "run.latest-problem" as const,
    severity: "error" as const,
    subject: "runs" as const,
    id: row.id,
    message:
      `Latest run ${row.id} for ${row.processorId} ended with ` +
      `${row.status} at ${row.finishedAt ?? "(unknown finish time)"}.`,
    recovery:
      "Use `dome inspect runs --limit 20 --json` for row-level detail. " +
      "If the failure has a matching source diagnostic, fix that source " +
      "issue and commit; if it looks transient, run `dome sync --json` " +
      "and rerun `dome check --json`.",
    run: Object.freeze({
      id: row.id,
      processorId: row.processorId,
      processorVersion: row.processorVersion,
      phase: row.phase,
      triggerKind: row.triggerKind,
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      durationMs: row.durationMs,
      error: row.error,
    }),
  });
}

export function projectionCacheDriftFinding(): HealthFinding {
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

export async function adoptedRefDivergenceFinding(
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
  // The orphaned side is HEAD..adopted: previously-adopted engine/human
  // commits the rewrite removed from the branch's ancestry. rev-list --count
  // is cheap even across divergent histories; null means "unknown".
  const orphanedCommits = await countCommitsOnlyIn({
    path: vaultPath,
    tip: adopted,
    exclude: head,
  });
  return Object.freeze({
    code: "adopted-ref.diverged" as const,
    severity: "error" as const,
    subject: "git" as const,
    id: `refs/dome/adopted/${branch}`,
    message:
      `Adopted ref for ${branch} (${adopted.slice(0, 7)}) is not an ` +
      `ancestor of HEAD (${head.slice(0, 7)}); the branch history was ` +
      `rebased, reset, or force-updated under the adopted cursor` +
      (orphanedCommits === null
        ? "."
        : ` (${orphanedCommits} previously-adopted commit${
            orphanedCommits === 1 ? " is" : "s are"
          } no longer reachable from HEAD).`),
    recovery:
      "Inspect both sides (`git log --oneline " +
      `${head.slice(0, 7)}..${adopted.slice(0, 7)}\`), then either restore ` +
      "the prior history via `git reflog` / `git reset --hard`, or run " +
      "`dome reanchor` to accept the rewritten HEAD as the new adoption " +
      "baseline (the old adopted SHA is preserved under refs/dome/backup/). " +
      "See docs/wiki/gotchas/adopted-ref-divergence.md.",
    git: Object.freeze({ branch, head, adopted, orphanedCommits }),
  });
}

export function instructionDriftFindings(vaultPath: string): ReadonlyArray<HealthFinding> {
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

export function instructionDriftFinding(id: string, message: string): HealthFinding {
  return Object.freeze({
    code: "instructions.drift" as const,
    severity: "warning" as const,
    subject: "instructions" as const,
    id,
    message,
    recovery:
      "Run `dome init --refresh-instructions` to repair orientation shims " +
      "without overwriting user prose.",
  });
}

export function collectOperationalSchemaFindings(
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
        knownPriorHash: ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY,
      }),
      operationalSchemaFinding({
        database: "outbox",
        path: join(statePath, "outbox.db"),
        table: "outbox_meta",
        expected: computeOutboxSchemaHash(),
        knownPriorHash: OUTBOX_SCHEMA_HASH_BEFORE_NEXT_ATTEMPT_AT,
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

export function operationalSchemaFinding(opts: {
  readonly database: "answers" | "outbox" | "ledger";
  readonly path: string;
  readonly table: string;
  readonly expected: string;
  /**
   * The one prior schema hash this store's `{kind:"migrate"}` open policy
   * upgrades in place (see `ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY` /
   * `OUTBOX_SCHEMA_HASH_BEFORE_NEXT_ATTEMPT_AT`). This probe runs BEFORE
   * `openVaultRuntime`, so a store sitting on exactly this hash is not
   * broken — it self-heals the moment any runtime command opens the vault.
   * Undefined for stores with no migratable prior hash (ledger refuses on
   * any mismatch), in which case every mismatch is a hard error.
   */
  readonly knownPriorHash?: string;
}): HealthFinding | null {
  if (!existsSync(opts.path)) return null;
  const stored = readOperationalSchemaHash(opts.path, opts.table);
  if (stored === opts.expected) return null;
  const migratable = stored !== null && stored === opts.knownPriorHash;
  return Object.freeze({
    code: "operational.schema-mismatch" as const,
    severity: migratable ? ("info" as const) : ("error" as const),
    subject: "storage" as const,
    id: `${opts.database}.schema`,
    message: migratable
      ? `${opts.database}.db is one schema version behind (hash ${stored}); ` +
        "it migrates in place automatically the next time the vault opens " +
        "(dome sync, dome serve, or any runtime command)."
      : `${opts.database}.db schema ${
          stored === null ? "could not be verified" : `hash ${stored}`
        }; expected ${opts.expected}.`,
    recovery: migratable
      ? "No action needed — open the vault with any runtime command (e.g. " +
        "`dome sync`) and the additive migration applies automatically."
      : "Do not delete operational state. Keep the file intact and run a " +
        "compatible Dome version or an explicit migration.",
    storage: Object.freeze({
      database: opts.database,
      path: opts.path,
      stored,
      expected: opts.expected,
    }),
  });
}

export function readOperationalSchemaHash(path: string, table: string): string | null {
  let db: Database;
  try {
    db = new Database(path, { readonly: true, create: false });
    db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
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

export function quarantineFinding(row: ProcessorQuarantineSnapshot): HealthFinding {
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
      "Run `dome sync --json` or keep `dome serve` running with dome.health " +
      "enabled to raise a reset question, then resolve it with " +
      "`dome resolve`. Use `dome inspect quarantine` only for row-level " +
      "detail.",
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
