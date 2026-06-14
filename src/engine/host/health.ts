// engine/host/health: read-only probes for operational recovery surfaces.
//
// Doctor needs one boring substrate read boundary instead of each CLI surface
// hand-assembling outbox, ledger, and quarantine checks. This module performs
// no mutation. Repairs still flow through the engine-asks model: findings
// become questions/answers and answer handlers apply the requested mutation.

import type {
  ManifestGrantEntry,
  ManifestGrantEntryRequirement,
} from "../../extensions/manifest-schema";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Database } from "bun:sqlite";

import { computeAnswersSchemaHash } from "../../answers/db";
import type { LedgerDb } from "../../ledger/db";
import { computeLedgerSchemaHash } from "../../ledger/db";
import {
  latestActiveProblemRuns,
  orphanRuns,
  ORPHAN_RECOVERY_EXCLUDED_PROCESSOR_PREFIXES,
  queryRunSummaries,
  type RunRow,
  type RunSummaryRow,
} from "../../ledger/runs";
import { countUnrehydratableQuestions } from "../../projections/questions";
import { nextFire, parseCron } from "../operational/cron";
import type { OutboxDb } from "../../outbox/db";
import { computeOutboxSchemaHash } from "../../outbox/db";
import { queryOutbox, type OutboxRow } from "../../outbox/dispatch";
import type { ProjectionDb } from "../../projections/db";
import { projectionCacheKeysChanged } from "../../projections/db";
import type {
  ProcessorExecutionState,
  ProcessorQuarantineSnapshot,
} from "../../processors/execution-state";
import { getAdoptedRef, getCurrentBranch } from "../../adopted-ref";
import { countCommitsOnlyIn, currentSha, isAncestor } from "../../git";
import type { Capability } from "../../core/processor";
import { canonicalVaultPath, type VaultPath } from "../../core/vault-path";
import { graphWriteCovers } from "../core/capability-broker";
import { globMatch } from "../core/glob-cache";
import { pathCapabilityMatches } from "../core/path-capabilities";
import type { ProcessorRegistry } from "../../processors/registry";
import type { ModelProviderProbeResult } from "./command-model-provider";

import { compareStrings } from "../../core/compare";

export const DEFAULT_ORPHAN_RUN_THRESHOLD_MS = 5 * 60 * 1000;
export const DEFAULT_PENDING_OUTBOX_THRESHOLD_MS = 30 * 60 * 1000;
/**
 * A failed outbox row whose enqueue age exceeds this window is treated as a
 * recurring (fix-the-command) failure rather than a fresh transient. One hour
 * is comfortably past the dispatch retry backoff plus a round of the
 * minute-cadence dome.health recovery loop, so a row still failing this long
 * after first enqueue is not a blip.
 */
export const DEFAULT_RECURRING_OUTBOX_FAILURE_THRESHOLD_MS = 60 * 60 * 1000;
/**
 * How many `timed_out` runs for one processor (within the scanned window)
 * constitute a recurring-timeout finding. Two clears a single unlucky blip
 * while still firing early on a genuine wedge (the live duplicate-detection
 * timed out ~30+ times).
 */
export const DEFAULT_RECURRING_TIMEOUT_THRESHOLD = 2;
/**
 * How many recent runs the recurring-timeout probe scans. Bounded so the
 * health tick stays cheap; large enough to catch a minute-cadence loop.
 */
export const RECURRING_TIMEOUT_SCAN_LIMIT = 200;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

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
      readonly code: "run.latest-problem";
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
        | "status"
        | "startedAt"
        | "finishedAt"
        | "durationMs"
        | "error"
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
      // A failed outbox row that has stayed failed well beyond its retry
      // budget — a fetcher/command that keeps re-failing on re-emit (the live
      // calendar fetch exits 1 every run), NOT a fresh transient. One
      // root-cause finding ("fix the command") distinct from the per-row
      // `outbox.failed` retry-or-abandon question.
      readonly code: "outbox.recurring-failure";
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
        | "enqueuedAt"
      >;
    }
  | {
      // N question rows can't be rehydrated (older-build/poison rows the
      // failure-isolating read skips). One finding for the whole backlog
      // rather than a stderr-only signal.
      readonly code: "questions.unreadable-backlog";
      readonly severity: "warning";
      readonly subject: "questions";
      readonly id: "unreadable_questions";
      readonly message: string;
      readonly recovery: string;
      readonly questions: {
        readonly unreadableCount: number;
      };
    }
  | {
      // One processor's runs repeatedly hit `timed_out` — raise its timeout or
      // scope it. Turns a silent serve.log timeout loop into one finding.
      readonly code: "run.recurring-timeout";
      readonly severity: "warning";
      readonly subject: "runs";
      readonly id: string;
      readonly message: string;
      readonly recovery: string;
      readonly run: {
        readonly processorId: string;
        readonly timedOutCount: number;
        readonly lastTimedOutAt: string | null;
      };
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
        /**
         * Commits reachable from the adopted ref but no longer reachable
         * from HEAD (`HEAD..adopted`) — the engine/human work the rewrite
         * orphaned. Null when the count could not be derived cheaply.
         */
        readonly orphanedCommits: number | null;
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
    }
  | {
      readonly code: "capability.grant-missing";
      readonly severity: "warning";
      readonly subject: "config";
      readonly id: string;
      readonly message: string;
      readonly recovery: string;
      readonly capability: {
        readonly processorId: string;
        readonly missingKinds: ReadonlyArray<Capability["kind"]>;
      };
    }
  | {
      readonly code: "capability.grant-entry-missing";
      readonly severity: "warning";
      readonly subject: "config";
      readonly id: string;
      readonly message: string;
      readonly recovery: string;
      readonly capability: {
        readonly processorId: string;
        readonly missingEntries: ReadonlyArray<{
          readonly kind: GrantEntryKind;
          readonly target: string;
        }>;
      };
    }
  | {
      readonly code: "capability.grant-starved";
      readonly severity: "info";
      readonly subject: "config";
      readonly id: string;
      readonly message: string;
      readonly recovery: string;
      readonly capability: {
        readonly processorId: string;
        readonly extensionId: string;
        readonly starved: ReadonlyArray<{
          readonly kind: "read" | "patch.auto";
          readonly pattern: string;
        }>;
      };
    }
  | {
      readonly code: "model.provider-missing";
      readonly severity: "warning";
      readonly subject: "config";
      readonly id: "model_provider";
      readonly message: string;
      readonly recovery: string;
      readonly model: {
        readonly processorIds: ReadonlyArray<string>;
      };
    }
  | {
      readonly code: "model.provider-unreachable";
      readonly severity: "error";
      readonly subject: "config";
      readonly id: "model_provider";
      readonly message: string;
      readonly recovery: string;
      readonly model: {
        readonly command: ReadonlyArray<string>;
        readonly probeStatus: "spawn-failed" | "invalid-response" | "timed-out";
        readonly detail: string;
      };
    }
  | {
      readonly code: "model.provider-key-missing";
      readonly severity: "warning";
      readonly subject: "config";
      readonly id: "model_provider";
      readonly message: string;
      readonly recovery: string;
      readonly model: {
        readonly command: ReadonlyArray<string>;
        readonly provider?: string;
      };
    }
  | {
      readonly code: "config.daily-path-mismatch";
      readonly severity: "warning";
      readonly subject: "config";
      readonly id: "daily_path";
      readonly message: string;
      readonly recovery: string;
      readonly config: {
        readonly dailyDailyPath: string | null;
        readonly agentDailyPath: string | null;
      };
    }
  | {
      readonly code: "config.sources-timeout-default";
      readonly severity: "info";
      readonly subject: "config";
      readonly id: "sources_timeout";
      readonly message: string;
      readonly recovery: string;
      readonly config: {
        /** The enabled dome.sources subscription kinds observed. */
        readonly enabledKinds: ReadonlyArray<string>;
      };
    }
  | {
      readonly code: "sources.fetch-script-missing";
      readonly severity: "warning";
      readonly subject: "config";
      readonly id: string;
      readonly message: string;
      readonly recovery: string;
      readonly sources: {
        /** The enabled subscription's kind (the config map key). */
        readonly kind: string;
        /** The script path the subscription command references. */
        readonly scriptPath: string;
      };
    }
  | {
      readonly code: "daily.edition-not-compiled";
      readonly severity: "warning";
      readonly subject: "daily";
      readonly id: "dome.agent.brief";
      readonly message: string;
      readonly recovery: string;
      readonly daily: {
        /** Local YYYY-MM-DD date of the missed edition. */
        readonly date: string;
        /** The brief's manifest cron expression. */
        readonly cron: string;
      };
    }
  | {
      readonly code: "daily.calendar-source-missing";
      readonly severity: "info";
      readonly subject: "daily";
      readonly id: "calendar_source";
      readonly message: string;
      readonly recovery: string;
      readonly daily: {
        /** The brief's two most recent run days (local YYYY-MM-DD, newest first). */
        readonly briefRunDates: ReadonlyArray<string>;
      };
    }
  | {
      readonly code: "git.commit-signing";
      readonly severity: "info";
      readonly subject: "git";
      readonly id: "commit_gpgsign";
      readonly message: string;
      readonly recovery: string;
    };

export type HealthSummary = {
  readonly findingCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  readonly failedOutbox: number;
  readonly stuckPendingOutbox: number;
  readonly orphanRuns: number;
  readonly failedRuns: number;
  readonly quarantinedProcessors: number;
  readonly projectionCacheDrift: number;
  readonly adoptedRefDivergence: number;
  readonly instructionDrift: number;
  readonly operationalSchemaMismatch: number;
  readonly capabilityGrantGaps: number;
  readonly capabilityGrantEntryGaps: number;
  readonly capabilityGrantStarvation: number;
  readonly modelProviderMissing: number;
  readonly modelProviderUnreachable: number;
  readonly modelProviderKeyMissing: number;
  readonly dailyPathMismatch: number;
  readonly sourcesTimeoutDefault: number;
  readonly sourcesFetchScriptMissing: number;
  readonly dailyEditionNotCompiled: number;
  readonly dailyCalendarSourceMissing: number;
  readonly gitCommitSigning: number;
  readonly recurringOutboxFailures: number;
  readonly unreadableQuestions: number;
  readonly recurringTimeouts: number;
};

/**
 * Finding code → HealthSummary count field. The single bookkeeping
 * surface for per-code counts: `buildHealthReport` derives the summary's
 * count fields from this table, and the `satisfies` clause enforces at
 * compile time that every finding code has exactly one summary field
 * (and that the field exists on HealthSummary). Row order is the JSON
 * key order of the emitted summary — `dome doctor --json` is a pinned
 * surface, so append-only edits here must keep field order in mind.
 */
const SUMMARY_FIELD_BY_CODE = Object.freeze({
  "outbox.failed": "failedOutbox",
  "outbox.pending-stuck": "stuckPendingOutbox",
  "run.orphan": "orphanRuns",
  "run.latest-problem": "failedRuns",
  "processor.quarantined": "quarantinedProcessors",
  "projection.cache-key-drift": "projectionCacheDrift",
  "adopted-ref.diverged": "adoptedRefDivergence",
  "instructions.drift": "instructionDrift",
  "operational.schema-mismatch": "operationalSchemaMismatch",
  "capability.grant-missing": "capabilityGrantGaps",
  "capability.grant-entry-missing": "capabilityGrantEntryGaps",
  "capability.grant-starved": "capabilityGrantStarvation",
  "model.provider-missing": "modelProviderMissing",
  "model.provider-unreachable": "modelProviderUnreachable",
  "model.provider-key-missing": "modelProviderKeyMissing",
  "config.daily-path-mismatch": "dailyPathMismatch",
  "config.sources-timeout-default": "sourcesTimeoutDefault",
  "sources.fetch-script-missing": "sourcesFetchScriptMissing",
  "daily.edition-not-compiled": "dailyEditionNotCompiled",
  "daily.calendar-source-missing": "dailyCalendarSourceMissing",
  "git.commit-signing": "gitCommitSigning",
  "outbox.recurring-failure": "recurringOutboxFailures",
  "questions.unreadable-backlog": "unreadableQuestions",
  "run.recurring-timeout": "recurringTimeouts",
} as const) satisfies Readonly<Record<HealthFinding["code"], keyof HealthSummary>>;

type CodeSummaryField =
  (typeof SUMMARY_FIELD_BY_CODE)[HealthFinding["code"]];

/**
 * Result of the doctor-side model provider probe, supplied by the caller
 * (the probe spawns the configured provider command, so it lives at the
 * `dome doctor` boundary, not inside this read-only module).
 */
export type ModelProviderProbeInput = {
  readonly command: ReadonlyArray<string>;
  readonly result: ModelProviderProbeResult;
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
  readonly capabilityPolicyHash: string;
  readonly registry?: ProcessorRegistry;
  readonly resolveGrants?: (
    processorId: string,
  ) => ReadonlyArray<Capability>;
  /** Processor → bundle id map (recovery wording for grant findings). */
  readonly extensionIdFor?: (processorId: string) => string;
  readonly extensionConfigFor?: (
    extensionId: string,
  ) => Readonly<Record<string, unknown>>;
  readonly modelProviderConfigured?: boolean;
  /**
   * Whether the vault sets `engine.external_handler_timeout_ms`. Feeds the
   * `config.sources-timeout-default` info finding (the model-fetcher
   * timeout footgun, wiki/specs/sources.md §"Timeout").
   */
  readonly externalHandlerTimeoutConfigured?: boolean;
  /** Composed manifest doctor contributions (`runtime.doctorGrantEntries`). */
  readonly doctorGrantEntries?: ReadonlyArray<ManifestGrantEntryRequirement>;
  readonly modelProviderProbe?: ModelProviderProbeInput;
  /**
   * The vault's effective `git config commit.gpgsign`, probed at the
   * `dome doctor` boundary (this module never spawns git). Undefined →
   * not probed (e.g. `dome check`); true → the `git.commit-signing`
   * info finding.
   */
  readonly commitSigningEnabled?: boolean;
  readonly now?: Date;
  readonly orphanRunThresholdMs?: number;
  readonly pendingOutboxThresholdMs?: number;
  readonly recurringOutboxFailureThresholdMs?: number;
  readonly recurringTimeoutThreshold?: number;
}): Promise<HealthReport> {
  const now = opts.now ?? new Date();
  const orphanRunThresholdMs =
    opts.orphanRunThresholdMs ?? DEFAULT_ORPHAN_RUN_THRESHOLD_MS;
  const pendingOutboxThresholdMs =
    opts.pendingOutboxThresholdMs ?? DEFAULT_PENDING_OUTBOX_THRESHOLD_MS;
  const failedOutbox = queryOutbox(opts.outbox, { status: "failed" });
  const stuckPendingOutbox = queryOutbox(opts.outbox, { status: "pending" })
    .filter((row) => isStuckPendingOutbox(row, now, pendingOutboxThresholdMs));
  // Self-referential orphan containment (Task 4b): the run.orphan finding is a
  // recovery surface, so it excludes the dome.health recovery processors' own
  // minute-cadence runs — otherwise the orphan-run detector raises a finding
  // about itself. A genuinely stuck health run is still visible via
  // `dome inspect orphan-runs` (which calls orphanRuns unfiltered).
  const orphaned = orphanRuns(opts.ledger, orphanRunThresholdMs, now, {
    excludeProcessorIdPrefixes: ORPHAN_RECOVERY_EXCLUDED_PROCESSOR_PREFIXES,
  });
  // Recurring-failure surfaces (Task 3): one root-cause finding instead of a
  // growing question stack / silent serve.log loop. All read-only and cheap.
  const recurringOutboxFailures = recurringOutboxFailureFindings({
    failedOutbox,
    now,
    ...(opts.recurringOutboxFailureThresholdMs !== undefined
      ? { thresholdMs: opts.recurringOutboxFailureThresholdMs }
      : {}),
  });
  const unreadableQuestions = unreadableQuestionBacklogFindings({
    unrehydratableCount: countUnrehydratableQuestions(opts.projection),
  });
  const recurringTimeouts = recurringTimeoutFindings({
    recentTimedOutRuns: queryRunSummaries(opts.ledger, {
      status: "timed_out",
      limit: RECURRING_TIMEOUT_SCAN_LIMIT,
    }),
    ...(opts.recurringTimeoutThreshold !== undefined
      ? { threshold: opts.recurringTimeoutThreshold }
      : {}),
  });
  // A latest-failure finding for a processor that is no longer registered
  // (bundle retired or disabled) can never be superseded by a newer run —
  // it would hold attention_required hostage forever (the stale
  // dome.intake.synthesize-rollup failure of 2026-06-08). Registry absent
  // (no bundles resolvable in this call shape) → no filtering.
  const failedRuns = latestActiveProblemRuns(opts.ledger).filter(
    (row) =>
      opts.registry === undefined ||
      opts.registry.get(row.processorId) !== undefined,
  );
  const quarantined = opts.executionState.quarantines();
  const projectionDrift = projectionCacheKeysChanged(opts.projection, {
    extensionSet: opts.extensions,
    processorVersions: opts.processorVersions,
    capabilityPolicyHash: opts.capabilityPolicyHash,
  })
    ? [projectionCacheDriftFinding()]
    : [];
  const adoptedDivergence = await adoptedRefDivergenceFinding(opts.vaultPath);
  const instructionDrift = instructionDriftFindings(opts.vaultPath);
  const storageSchema = collectOperationalSchemaFindings(opts.vaultPath);
  const capabilityGrants =
    opts.registry === undefined || opts.resolveGrants === undefined
      ? []
      : capabilityGrantFindings({
          registry: opts.registry,
          resolveGrants: opts.resolveGrants,
        });
  const capabilityGrantEntries =
    opts.registry === undefined || opts.resolveGrants === undefined
      ? []
      : capabilityGrantEntryFindings({
          registry: opts.registry,
          resolveGrants: opts.resolveGrants,
          requirements: opts.doctorGrantEntries ?? [],
        });
  const capabilityGrantStarvation =
    opts.registry === undefined || opts.resolveGrants === undefined
      ? []
      : capabilityGrantStarvationFindings({
          registry: opts.registry,
          resolveGrants: opts.resolveGrants,
          requirements: opts.doctorGrantEntries ?? [],
          ...(opts.extensionIdFor !== undefined
            ? { extensionIdFor: opts.extensionIdFor }
            : {}),
        });
  const modelProvider =
    opts.registry === undefined || opts.resolveGrants === undefined
      ? []
      : modelProviderFindings({
          registry: opts.registry,
          resolveGrants: opts.resolveGrants,
          modelProviderConfigured: opts.modelProviderConfigured === true,
        });
  const modelProviderProbe =
    opts.modelProviderProbe === undefined
      ? []
      : modelProviderProbeFindings(opts.modelProviderProbe);
  const dailyPathMismatch =
    opts.extensionConfigFor === undefined
      ? []
      : dailyPathMismatchFindings({
          extensions: opts.extensions,
          extensionConfigFor: opts.extensionConfigFor,
        });
  const sourcesTimeout =
    opts.extensionConfigFor === undefined
      ? []
      : sourcesHandlerTimeoutFindings({
          extensions: opts.extensions,
          extensionConfigFor: opts.extensionConfigFor,
          externalHandlerTimeoutConfigured:
            opts.externalHandlerTimeoutConfigured === true,
        });
  const sourcesFetchScript =
    opts.extensionConfigFor === undefined
      ? []
      : sourcesFetchScriptFindings({
          extensions: opts.extensions,
          extensionConfigFor: opts.extensionConfigFor,
          scriptIsFile: (scriptPath) => {
            const resolved = isAbsolute(scriptPath)
              ? scriptPath
              : join(opts.vaultPath, scriptPath);
            try {
              return statSync(resolved).isFile();
            } catch {
              return false;
            }
          },
        });
  const dailyEdition =
    opts.registry === undefined
      ? []
      : dailyEditionFindings({
          now,
          briefCron: briefScheduleCron(opts.registry),
          briefRunDates: briefRunDates(opts.ledger),
          calendarFileExists: (date) =>
            existsSync(
              join(opts.vaultPath, "sources", "calendar", `${date}.md`),
            ),
        });

  const commitSigning =
    opts.commitSigningEnabled === true
      ? [commitSigningFinding()]
      : [];

  const findings: HealthFinding[] = [
    ...storageSchema,
    ...capabilityGrants,
    ...capabilityGrantEntries,
    ...capabilityGrantStarvation,
    ...modelProvider,
    ...modelProviderProbe,
    ...dailyPathMismatch,
    ...sourcesTimeout,
    ...sourcesFetchScript,
    ...dailyEdition,
    ...commitSigning,
    ...failedOutbox.map(outboxFinding),
    ...recurringOutboxFailures,
    ...stuckPendingOutbox.map(stuckPendingOutboxFinding),
    ...orphaned.map(orphanFinding),
    ...failedRuns.map(latestProblemRunFinding),
    ...recurringTimeouts,
    ...quarantined.map(quarantineFinding),
    ...unreadableQuestions,
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
  const infoCount = findings.filter((f) => f.severity === "info").length;
  // Per-code counts derive from SUMMARY_FIELD_BY_CODE; Object.entries
  // iterates in declaration order, so the emitted JSON field order is the
  // table's row order (the pinned `dome doctor --json` summary shape).
  const codeCounts = Object.fromEntries(
    (
      Object.entries(SUMMARY_FIELD_BY_CODE) as Array<
        [HealthFinding["code"], CodeSummaryField]
      >
    ).map(([code, field]) => [
      field,
      findings.filter((f) => f.code === code).length,
    ]),
  ) as Record<CodeSummaryField, number>;

  return Object.freeze({
    // Info findings are FYI, never ill health: a report whose only findings
    // are info-severity (e.g. daily.calendar-source-missing on a deliberately
    // calendar-less vault) stays "ok".
    status: errorCount + warningCount === 0 ? "ok" : "unhealthy",
    generatedAt: now.toISOString(),
    summary: Object.freeze({
      findingCount: findings.length,
      errorCount,
      warningCount,
      infoCount,
      ...codeCounts,
    }),
    findings: Object.freeze([...findings]),
  });
}

function capabilityGrantFindings(opts: {
  readonly registry: ProcessorRegistry;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
}): ReadonlyArray<HealthFinding> {
  const findings: HealthFinding[] = [];
  for (const processor of [...opts.registry.all()].sort((a, b) =>
    compareStrings(a.id, b.id),
  )) {
    const declaredKinds = capabilityKinds(processor.capabilities);
    if (declaredKinds.size === 0) continue;
    const grantedKinds = capabilityKinds(opts.resolveGrants(processor.id));
    const missingKinds = [...declaredKinds]
      .filter((kind) => !grantedKinds.has(kind))
      .sort();
    if (missingKinds.length === 0) continue;
    findings.push(
      Object.freeze({
        code: "capability.grant-missing" as const,
        severity: "warning" as const,
        subject: "config" as const,
        id: processor.id,
        message:
          `Processor ${processor.id} declares ` +
          `${formatList(missingKinds)} but the vault config does not grant ` +
          `${missingKinds.length === 1 ? "that capability" : "those capabilities"}.`,
        recovery:
          "Update .dome/config.yaml to grant the capability, or disable the " +
          "processor/bundle if the missing capability is intentionally denied.",
        capability: Object.freeze({
          processorId: processor.id,
          missingKinds: Object.freeze(missingKinds),
        }),
      }),
    );
  }
  return Object.freeze(findings);
}

function capabilityKinds(
  capabilities: ReadonlyArray<Capability>,
): ReadonlySet<Capability["kind"]> {
  return new Set(capabilities.map((capability) => capability.kind));
}

// ----- Grant-entry probes ------------------------------------------------------
//
// `dome init --refresh-config` fills only MISSING grant keys for already
// enabled bundles — it never merges new entries into a key the vault already
// carries (grant lists are user-owned config; auto-merging is too risky). So
// a vault that predates a bundle's newer behavior keeps its old grant lists
// and silently loses that behavior: the kind is granted but the specific
// entry is not, which the kind-level `capability.grant-missing` probe cannot
// see. These probes name the exact YAML to add.
//
// The requirements are a MANIFEST CONTRIBUTION (`doctor.grantEntries`, per
// [[wiki/gotchas/operator-surfaces-enumerate-first-party]]): each bundle
// declares its own, the runtime composes active bundles' entries, and this
// evaluator stays bundle-agnostic. A row fires only when the processor is
// loaded (bundle enabled), the manifest still declares the entry, and the
// kind IS granted (a wholly missing kind is the kind-level finding's job).

export type GrantEntryKind = "read" | "patch.auto" | "graph.write";

type GrantEntry = ManifestGrantEntry;

export function capabilityGrantEntryFindings(opts: {
  readonly registry: ProcessorRegistry;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly requirements: ReadonlyArray<ManifestGrantEntryRequirement>;
}): ReadonlyArray<HealthFinding> {
  const findings: HealthFinding[] = [];
  for (const requirement of opts.requirements) {
    const processor = opts.registry.get(requirement.processorId);
    if (processor === undefined) continue; // bundle not enabled / not loaded
    const granted = opts.resolveGrants(requirement.processorId);
    const grantedKinds = capabilityKinds(granted);
    const missing = requirement.entries.filter(
      (entry) =>
        // The manifest must still declare the entry (the table cannot
        // outlive a manifest retrenchment) ...
        grantEntryCovered(entry, processor.capabilities) &&
        // ... the kind must be granted at all (a wholly missing kind is
        // `capability.grant-missing`'s finding) ...
        grantedKinds.has(entry.kind) &&
        // ... and the granted patterns must miss the specific entry.
        !grantEntryCovered(entry, granted),
    );
    if (missing.length === 0) continue;
    findings.push(
      Object.freeze({
        code: "capability.grant-entry-missing" as const,
        severity: "warning" as const,
        subject: "config" as const,
        id: [
          requirement.processorId,
          ...missing.map((entry) => `${entry.kind}:${entry.target}`),
        ].join("|"),
        message:
          `Processor ${requirement.processorId} declares ` +
          formatGrantEntries(missing) +
          " but the vault grant does not cover " +
          `${missing.length === 1 ? "that entry" : "those entries"}; ` +
          `${requirement.why}.`,
        recovery: requirement.recovery,
        capability: Object.freeze({
          processorId: requirement.processorId,
          missingEntries: Object.freeze(
            missing.map((entry) =>
              Object.freeze({ kind: entry.kind, target: entry.target }),
            ),
          ),
        }),
      }),
    );
  }
  return Object.freeze(findings);
}

function grantEntryCovered(
  entry: GrantEntry,
  caps: ReadonlyArray<Capability>,
): boolean {
  if (entry.kind === "graph.write") {
    return graphWriteCovers(entry.target, caps);
  }
  const path = canonicalVaultPath(entry.target);
  if (path === null) return false;
  return pathCapabilityMatches(entry.kind, path, caps);
}

function formatGrantEntries(entries: ReadonlyArray<GrantEntry>): string {
  return entries
    .map((entry) => `'${entry.kind}' over '${entry.target}'`)
    .join(", ");
}

// ----- General grant-starvation probe ------------------------------------------
//
// Grant-scoped snapshot misses are silent: a processor whose manifest
// declares a `read`/`patch.auto` pattern the vault grant does not cover just
// never sees the files (manifest ∩ grant = ∅, no diagnostic) — this is how
// the owner's calendar weave was silently ungranted for weeks. Unlike the
// hand-curated `doctor.grantEntries` rows above, this probe is GENERAL: it
// derives a representative concrete path from every declared pattern of
// every loaded processor and reports the patterns whose representative the
// effective grant misses. Info severity by design — narrowed grants can be
// deliberate, and the effective grant already respects per-processor
// replacement grants (capability-policy resolves a replacement grant INSTEAD
// of the bundle grant, so a narrow replacement is judged against itself).
// Hand rows keep precedence: a pattern that covers a hand-row entry's target
// for the same processor + kind is skipped here (the hand row carries the
// curated messaging for that gap).

const STARVATION_KINDS = ["read", "patch.auto"] as const;
type StarvationKind = (typeof STARVATION_KINDS)[number];

export function capabilityGrantStarvationFindings(opts: {
  readonly registry: ProcessorRegistry;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  /** Hand-curated rows (`doctor.grantEntries`) — these keep precedence. */
  readonly requirements: ReadonlyArray<ManifestGrantEntryRequirement>;
  /** Processor → bundle id (recovery wording); falls back to processor id. */
  readonly extensionIdFor?: (processorId: string) => string;
}): ReadonlyArray<HealthFinding> {
  const findings: HealthFinding[] = [];
  for (const processor of [...opts.registry.all()].sort((a, b) =>
    compareStrings(a.id, b.id),
  )) {
    const granted = opts.resolveGrants(processor.id);
    const grantedKinds = capabilityKinds(granted);
    const handEntries = opts.requirements
      .filter((requirement) => requirement.processorId === processor.id)
      .flatMap((requirement) => requirement.entries);
    const starved: Array<{ kind: StarvationKind; pattern: string }> = [];
    for (const capability of processor.capabilities) {
      if (capability.kind !== "read" && capability.kind !== "patch.auto") {
        continue;
      }
      const kind: StarvationKind = capability.kind;
      // A wholly missing kind is `capability.grant-missing`'s finding.
      if (!grantedKinds.has(kind)) continue;
      for (const pattern of capability.paths) {
        // Hand-row precedence: the curated row already watches this gap.
        if (
          handEntries.some(
            (entry) => entry.kind === kind && globMatch(pattern, entry.target),
          )
        ) {
          continue;
        }
        const representative = representativeTargetForPattern(pattern);
        // Nothing checkable derivable from the pattern — never a finding.
        if (representative === null) continue;
        if (pathCapabilityMatches(kind, representative, granted)) continue;
        // Deliberate-narrowing suppression: a granted pattern strictly
        // WITHIN the declared pattern (e.g. grant wiki/entities/**/*.md
        // under declared wiki/**/*.md) means the processor acts on the
        // granted subset — narrowed by choice, not silently starving. Only
        // a declared pattern with ZERO grant intersection (the
        // calendar-weave failure mode) is reported.
        if (grantNarrowsWithin(kind, pattern, granted)) continue;
        starved.push({ kind, pattern });
      }
    }
    if (starved.length === 0) continue;
    const extensionId = opts.extensionIdFor?.(processor.id) ?? processor.id;
    findings.push(
      Object.freeze({
        code: "capability.grant-starved" as const,
        severity: "info" as const,
        subject: "config" as const,
        id: [
          processor.id,
          ...starved.map((entry) => `${entry.kind}:${entry.pattern}`),
        ].join("|"),
        message:
          `Processor ${processor.id} declares ` +
          starved
            .map((entry) => `'${entry.kind}' over '${entry.pattern}'`)
            .join(", ") +
          " but the effective vault grant does not cover " +
          `${starved.length === 1 ? "that pattern" : "those patterns"}; ` +
          "grant-scoped snapshots silently omit the matching files, so the " +
          "processor never acts on them.",
        recovery:
          "If the narrowing is deliberate, ignore this info finding. " +
          `Otherwise add the missing pattern(s) under ` +
          `extensions.${extensionId}.grant.<kind> in .dome/config.yaml — or ` +
          `under extensions.${extensionId}.processors.` +
          `"${processor.id}".grant when the vault carries a per-processor ` +
          "replacement grant for it.",
        capability: Object.freeze({
          processorId: processor.id,
          extensionId,
          starved: Object.freeze(
            starved.map((entry) =>
              Object.freeze({ kind: entry.kind, pattern: entry.pattern }),
            ),
          ),
        }),
      }),
    );
  }
  return Object.freeze(findings);
}

/**
 * True when some granted pattern of `kind` lies WITHIN the declared
 * pattern — detected by deriving the granted pattern's representative path
 * and asking whether the declared pattern matches it. Partial coverage
 * means the processor does act inside the granted subset, so the gap is a
 * deliberate narrowing rather than silent starvation.
 */
function grantNarrowsWithin(
  kind: StarvationKind,
  declaredPattern: string,
  granted: ReadonlyArray<Capability>,
): boolean {
  for (const cap of granted) {
    if (cap.kind !== kind) continue;
    for (const grantedPattern of cap.paths) {
      const representative = representativeTargetForPattern(grantedPattern);
      if (representative === null) continue;
      if (globMatch(declaredPattern, representative)) return true;
    }
  }
  return false;
}

/**
 * Derive a concrete vault path that `pattern` matches, by replacing glob
 * constructs with literals: the first alternative of each `{a,b}` group,
 * `probe` for `*`/`**` runs, `x` for `?`. The derivation is sanity-checked
 * against the broker's own matcher — a pattern whose derived literal it
 * does not match (exotic character classes, etc.) yields null, and null
 * means "nothing checkable", never a finding.
 */
function representativeTargetForPattern(pattern: string): VaultPath | null {
  const literal = pattern
    .replace(/\{([^{}]*)\}/g, (_match, body: string) => body.split(",")[0] ?? "")
    .replace(/\*+/g, "probe")
    .replace(/\?/g, "x");
  const path = canonicalVaultPath(literal);
  if (path === null) return null;
  return globMatch(pattern, path) ? path : null;
}

function modelProviderFindings(opts: {
  readonly registry: ProcessorRegistry;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly modelProviderConfigured: boolean;
}): ReadonlyArray<HealthFinding> {
  if (opts.modelProviderConfigured) return Object.freeze([]);

  const processorIds = [...opts.registry.all()]
    .filter((processor) =>
      capabilityKinds(processor.capabilities).has("model.invoke") &&
      capabilityKinds(opts.resolveGrants(processor.id)).has("model.invoke"),
    )
    .map((processor) => processor.id)
    .sort();
  if (processorIds.length === 0) return Object.freeze([]);

  return Object.freeze([
    Object.freeze({
      code: "model.provider-missing" as const,
      severity: "warning" as const,
      subject: "config" as const,
      id: "model_provider" as const,
      message:
        `${processorIds.length} enabled processor(s) can invoke models, ` +
        "but no model provider is configured for this vault.",
      recovery:
        "Configure model_provider in .dome/config.yaml, run the host with an " +
        "injected ModelProvider, or disable the model-capable bundle until " +
        "the provider is ready.",
      model: Object.freeze({
        processorIds: Object.freeze(processorIds),
      }),
    }),
  ]);
}

/**
 * Translate a doctor-side provider probe into findings. Per
 * docs/wiki/specs/cli.md §"dome doctor":
 *
 * - `responsive` with `keyPresent: false` → `model.provider-key-missing`
 *   (warning) — reachability and credential presence are reported
 *   separately.
 * - `spawn-failed` / `invalid-response` / `timed-out` →
 *   `model.provider-unreachable` (error).
 * - `responsive` with key present and `probe-unsupported` (a pre-probe
 *   provider that started, read the envelope, and returned a well-formed
 *   error) → no finding.
 */
function modelProviderProbeFindings(
  probe: ModelProviderProbeInput,
): ReadonlyArray<HealthFinding> {
  const command = Object.freeze([...probe.command]);
  const result = probe.result;
  if (
    result.status === "spawn-failed" ||
    result.status === "invalid-response" ||
    result.status === "timed-out"
  ) {
    return Object.freeze([
      Object.freeze({
        code: "model.provider-unreachable" as const,
        severity: "error" as const,
        subject: "config" as const,
        id: "model_provider" as const,
        message:
          `The configured model provider command (${command.join(" ")}) ` +
          `failed the dome.model-provider.probe/v1 probe: ` +
          `${result.status} — ${result.detail}`,
        recovery:
          "Run the command manually from the vault root with a probe " +
          'envelope (echo \'{"schema":"dome.model-provider.probe/v1"}\' | ' +
          "<command>) to reproduce, fix the script or the model_provider " +
          "command in .dome/config.yaml, then re-run `dome doctor`.",
        model: Object.freeze({
          command,
          probeStatus: result.status,
          detail: result.detail,
        }),
      }),
    ]);
  }
  if (result.status === "responsive" && result.keyPresent === false) {
    return Object.freeze([
      Object.freeze({
        code: "model.provider-key-missing" as const,
        severity: "warning" as const,
        subject: "config" as const,
        id: "model_provider" as const,
        message:
          `The configured model provider command (${command.join(" ")}) is ` +
          "spawnable and probe-responsive, but reports its credential " +
          "environment variable is not set" +
          (result.provider === undefined
            ? "."
            : ` (provider: ${result.provider}).`),
        recovery:
          "Export the provider's API key (ANTHROPIC_API_KEY for the shipped " +
          "anthropic template) in the environment that runs `dome serve` / " +
          "`dome sync` — for a `dome install`ed daemon that means the " +
          "launchd service environment — then re-run `dome doctor`.",
        model: Object.freeze({
          command,
          ...(result.provider !== undefined
            ? { provider: result.provider }
            : {}),
        }),
      }),
    ]);
  }
  return Object.freeze([]);
}

/**
 * Mirrored-config check for the daily note path. `dome.agent.brief` resolves
 * the daily note from `extensions.dome.agent.config.daily_path` while
 * `dome.daily.create-daily` reads `extensions.dome.daily.config.daily_path`
 * — a vault overriding only one gets a wrong-path morning brief plus a
 * duplicate skeleton at 06:00. When both bundles are enabled, the two keys
 * must agree (both unset = both on the shared default = fine). The engine
 * compares the raw config values — it deliberately does not know the
 * bundles' default template, only that divergent keys diverge.
 */
export function dailyPathMismatchFindings(opts: {
  readonly extensions: ReadonlyArray<{ readonly name: string }>;
  readonly extensionConfigFor: (
    extensionId: string,
  ) => Readonly<Record<string, unknown>>;
}): ReadonlyArray<HealthFinding> {
  const enabled = new Set(opts.extensions.map((extension) => extension.name));
  if (!enabled.has("dome.daily") || !enabled.has("dome.agent")) {
    return Object.freeze([]);
  }
  const dailyDailyPath = dailyPathConfigValue(
    opts.extensionConfigFor("dome.daily"),
  );
  const agentDailyPath = dailyPathConfigValue(
    opts.extensionConfigFor("dome.agent"),
  );
  if (dailyDailyPath === agentDailyPath) return Object.freeze([]);
  const render = (value: string | null): string =>
    value === null ? "(unset — bundle default)" : `"${value}"`;
  return Object.freeze([
    Object.freeze({
      code: "config.daily-path-mismatch" as const,
      severity: "warning" as const,
      subject: "config" as const,
      id: "daily_path" as const,
      message:
        "dome.daily and dome.agent resolve the daily note from different " +
        `daily_path values (dome.daily: ${render(dailyDailyPath)}, ` +
        `dome.agent: ${render(agentDailyPath)}); the morning brief would ` +
        "write a different file than create-daily, leaving a wrong-path " +
        "brief plus a duplicate daily skeleton.",
      recovery:
        "Declare the path once: set shared_config.daily_path in " +
        ".dome/config.yaml and remove the per-extension " +
        "extensions.*.config.daily_path overrides (an extension's own key " +
        "overrides the shared value, which is how this fork happened).",
      config: Object.freeze({ dailyDailyPath, agentDailyPath }),
    }),
  ]);
}

function dailyPathConfigValue(
  config: Readonly<Record<string, unknown>>,
): string | null {
  const raw = config.daily_path;
  return typeof raw === "string" ? raw : null;
}

/**
 * The model-fetcher timeout footgun (wiki/specs/sources.md §"Timeout").
 * Trigger — the simplest honest one: ANY dome.sources subscription is
 * enabled while `engine.external_handler_timeout_ms` is unset. The 30s
 * dispatch default fits direct API fetchers (which is why this stays
 * info severity, never ill health), but a model-backed fetch command
 * (the shipped claude-calendar template) rides the timeout out and dies;
 * discovering that from failed outbox rows is miserable. Doctor says it
 * up front instead. We deliberately do NOT sniff the command for a
 * "claude" pattern — a wrapper script hides it, and a fast fetcher named
 * claude-anything would false-positive; subscription-enabled + timeout-
 * unset is the honest observable.
 */
export function sourcesHandlerTimeoutFindings(opts: {
  readonly extensions: ReadonlyArray<{ readonly name: string }>;
  readonly extensionConfigFor: (
    extensionId: string,
  ) => Readonly<Record<string, unknown>>;
  readonly externalHandlerTimeoutConfigured: boolean;
}): ReadonlyArray<HealthFinding> {
  if (opts.externalHandlerTimeoutConfigured) return Object.freeze([]);
  if (!opts.extensions.some((e) => e.name === "dome.sources")) {
    return Object.freeze([]);
  }
  const enabledKinds = enabledSubscriptionKinds(
    opts.extensionConfigFor("dome.sources"),
  );
  if (enabledKinds.length === 0) return Object.freeze([]);
  return Object.freeze([
    Object.freeze({
      code: "config.sources-timeout-default" as const,
      severity: "info" as const,
      subject: "config" as const,
      id: "sources_timeout" as const,
      message:
        `dome.sources subscription(s) ${enabledKinds.join(", ")} are enabled ` +
        "while engine.external_handler_timeout_ms is unset — each fetch " +
        "attempt is bounded by the 30s dispatch default. Direct API " +
        "fetchers fit; a model-backed fetch command (the claude-calendar " +
        "template) will time out.",
      recovery:
        "If the fetch command runs a headless model, set " +
        "engine.external_handler_timeout_ms: 300000 in .dome/config.yaml; " +
        "if it is a direct API fetcher, ignore this.",
      config: Object.freeze({ enabledKinds }),
    }),
  ]);
}

/**
 * Minimal, fallback-not-crash read of
 * `extensions.dome.sources.config.subscriptions` for the timeout finding:
 * map entries whose `enabled` is exactly true. Deliberately does not
 * import the bundle's resolver — src never imports assets/, and the
 * finding only needs intent (enabled), not validity.
 */
function enabledSubscriptionKinds(
  config: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> {
  return Object.freeze(
    enabledSubscriptionEntries(config).map((entry) => entry.kind),
  );
}

/**
 * The `enabled: true` entries of
 * `extensions.dome.sources.config.subscriptions`, sorted by kind.
 * Fallback-not-crash like `enabledSubscriptionKinds` (which derives from
 * this): junk shapes yield no entries.
 */
function enabledSubscriptionEntries(
  config: Readonly<Record<string, unknown>>,
): ReadonlyArray<{
  readonly kind: string;
  readonly subscription: Readonly<Record<string, unknown>>;
}> {
  const raw = config.subscriptions;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return Object.freeze([]);
  }
  return Object.freeze(
    Object.entries(raw as Record<string, unknown>)
      .filter(
        (pair): pair is [string, Record<string, unknown>] => {
          const entry = pair[1];
          return (
            entry !== null &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            (entry as Record<string, unknown>).enabled === true
          );
        },
      )
      .map(([kind, subscription]) => Object.freeze({ kind, subscription }))
      .sort((a, b) => compareStrings(a.kind, b.kind)),
  );
}

/**
 * The missing-fetch-script probe (`sources.fetch-script-missing`): an
 * enabled dome.sources subscription whose command references a script file
 * that is missing (or not a regular file) fails on every scheduled fetch.
 * Doctor says so up front — kind, path, and the `dome init --with-source`
 * recovery — instead of leaving the owner to decode failed outbox rows the
 * next morning.
 *
 * STATIC by design: doctor never executes the fetch command (it would hit
 * Slack/calendar for real). The script reference is derived without running
 * anything: command[0] when it contains a path separator, else command[1]
 * for the standard `["sh", ".dome/bin/fetch-<kind>.sh"]` interpreter shape
 * (skipping flag arguments). Commands with no checkable reference — bare
 * PATH lookups, `sh -c` inline scripts — are skipped: a false positive on a
 * working command would be worse than silence, and their failures still
 * surface through the outbox findings.
 */
export function sourcesFetchScriptFindings(opts: {
  readonly extensions: ReadonlyArray<{ readonly name: string }>;
  readonly extensionConfigFor: (
    extensionId: string,
  ) => Readonly<Record<string, unknown>>;
  /** Whether `path` (vault-relative or absolute) is an existing regular file. */
  readonly scriptIsFile: (path: string) => boolean;
}): ReadonlyArray<HealthFinding> {
  if (!opts.extensions.some((e) => e.name === "dome.sources")) {
    return Object.freeze([]);
  }
  const findings: HealthFinding[] = [];
  for (const { kind, subscription } of enabledSubscriptionEntries(
    opts.extensionConfigFor("dome.sources"),
  )) {
    const scriptPath = referencedScriptPath(subscription.command);
    if (scriptPath === null) continue;
    if (opts.scriptIsFile(scriptPath)) continue;
    findings.push(
      Object.freeze({
        code: "sources.fetch-script-missing" as const,
        severity: "warning" as const,
        subject: "config" as const,
        id: `sources_fetch:${kind}`,
        message:
          `The enabled dome.sources "${kind}" subscription's fetch command ` +
          `references ${scriptPath}, which is missing or not a regular ` +
          "file — every scheduled fetch will fail.",
        recovery:
          `Run \`dome init --with-source ${kind}\` to scaffold the shipped ` +
          `fetch adapter (shipped kinds: calendar, slack) and review it ` +
          `before relying on it, write your own script at ${scriptPath}, ` +
          "or fix the subscription command in .dome/config.yaml.",
        sources: Object.freeze({ kind, scriptPath }),
      }),
    );
  }
  return Object.freeze(findings);
}

/**
 * The script file a subscription command references, if any can be derived
 * statically: command[0] when it carries a path separator (a direct script
 * invocation), else command[1] when command[0] is a bare interpreter name
 * and command[1] looks like a path rather than a flag. Null means "nothing
 * checkable" — never a finding.
 */
function referencedScriptPath(command: unknown): string | null {
  if (!Array.isArray(command)) return null;
  const first = command[0];
  if (typeof first !== "string" || first.length === 0) return null;
  if (first.includes("/")) return first;
  const second = command[1];
  if (
    typeof second === "string" &&
    !second.startsWith("-") &&
    second.includes("/")
  ) {
    return second;
  }
  return null;
}

// ----- Daily-edition choreography probes --------------------------------------
//
// "Did my morning happen" without reading the daily note. Two read-only,
// idempotent probes over the run ledger + the working tree, normative at
// docs/wiki/specs/daily-surface.md §"Doctor choreography findings". Never an
// error: the edition's absence is degradation, not corruption.

/**
 * The two daily-edition findings:
 *
 * - `daily.edition-not-compiled` (warning) — the brief is enabled, its cron
 *   time has passed today, the ledger has no brief run started today, and
 *   the ledger DOES record a brief run on some earlier day (the pipeline was
 *   alive before — this is a recovery signal, not an onboarding nag; a
 *   freshly enabled vault stays quiet until its first morning lands). The
 *   usual cause is a stopped host (cron fires only while `dome serve` runs)
 *   or a sick model provider.
 * - `daily.calendar-source-missing` (info) — `sources/calendar/<date>.md`
 *   is absent for BOTH of the brief's two most recent run days. One missing
 *   day is normal; two ledger-evidenced agenda-less mornings suggest the
 *   vault-side calendar fetcher (vault-layout's recipe) is not wired or has
 *   stopped. Cheap-derivation call: "existed at brief time" is approximated
 *   by "exists in the working tree now" — calendar files are committed feeds
 *   and essentially never backfilled, and a backfill self-heals the finding,
 *   which is acceptable at info severity. "Consecutive days" means the two
 *   most recent RUN days, not wall-calendar days, so a host that was off for
 *   a day neither manufactures nor suppresses the signal.
 */
export function dailyEditionFindings(opts: {
  readonly now: Date;
  /**
   * The brief's manifest cron expression; null when `dome.agent.brief` is
   * not enabled/loaded (both probes stay silent).
   */
  readonly briefCron: string | null;
  /**
   * Distinct local dates (YYYY-MM-DD, newest first) on which the run ledger
   * records a `dome.agent.brief` run of any status — a failed run still
   * proves the scheduler fired (failures are `run.latest-problem`'s job).
   */
  readonly briefRunDates: ReadonlyArray<string>;
  /** Whether `sources/calendar/<date>.md` exists in the vault working tree. */
  readonly calendarFileExists: (date: string) => boolean;
}): ReadonlyArray<HealthFinding> {
  if (opts.briefCron === null) return Object.freeze([]);
  const findings: HealthFinding[] = [];

  const today = formatLocalDate(opts.now);
  const scheduledTimePassedToday = cronFiredToday(opts.briefCron, opts.now);
  if (
    scheduledTimePassedToday &&
    opts.briefRunDates.length > 0 &&
    !opts.briefRunDates.includes(today)
  ) {
    findings.push(
      Object.freeze({
        code: "daily.edition-not-compiled" as const,
        severity: "warning" as const,
        subject: "daily" as const,
        id: "dome.agent.brief" as const,
        message:
          `dome.agent.brief was scheduled today (cron "${opts.briefCron}") ` +
          `and the scheduled time has passed, but the run ledger has no ` +
          `brief run for ${today} — this morning's edition was not compiled.`,
        recovery:
          "Check that `dome serve` is running (scheduled processors fire " +
          "only while the host runs) and review this report's model-provider " +
          "findings; then run `dome sync --json` and re-run `dome doctor`.",
        daily: Object.freeze({ date: today, cron: opts.briefCron }),
      }),
    );
  }

  const recentRunDates = opts.briefRunDates.slice(0, 2);
  if (
    recentRunDates.length === 2 &&
    recentRunDates.every((date) => !opts.calendarFileExists(date))
  ) {
    findings.push(
      Object.freeze({
        code: "daily.calendar-source-missing" as const,
        severity: "info" as const,
        subject: "daily" as const,
        id: "calendar_source" as const,
        message:
          `No sources/calendar/<date>.md existed for the morning brief's ` +
          `last 2 run days (${recentRunDates.join(", ")}); the edition's ` +
          `meetings section was omitted both mornings.`,
        recovery:
          "Enable the dome.sources calendar subscription (config + a " +
          ".dome/bin fetch command — see docs/wiki/specs/sources.md) or " +
          "wire a vault-side fetcher that commits sources/calendar/<date>.md " +
          "before the brief (docs/wiki/specs/vault-layout.md §\"Populating " +
          "the calendar file\"). A deliberately calendar-less vault may " +
          "ignore this info finding.",
        daily: Object.freeze({
          briefRunDates: Object.freeze([...recentRunDates]),
        }),
      }),
    );
  }

  return Object.freeze(findings);
}

/**
 * The `git.commit-signing` info finding (the day-one GPG hazard from the
 * second-user ledger): the vault's effective git config — usually the
 * inherited global config — enables commit signing. Dome's own commit
 * paths are immune (engine adoption commits and `dome capture` go through
 * isomorphic-git, which never invokes gpg; the shipped dome.sources fetch
 * templates commit with `git -c commit.gpgsign=false`), so this is purely
 * informational: it names the still-affected paths (the owner's own
 * `git commit` and any custom vault-side script shelling plain
 * `git commit`) instead of letting a non-interactive signing failure
 * surface as a mystery later.
 */
function commitSigningFinding(): HealthFinding {
  return Object.freeze({
    code: "git.commit-signing" as const,
    severity: "info" as const,
    subject: "git" as const,
    id: "commit_gpgsign" as const,
    message:
      "This vault's effective git config sets commit.gpgsign=true (often " +
      "inherited from the global config). Dome's own commit paths are " +
      "immune — engine adoption commits and `dome capture` use " +
      "isomorphic-git (which never invokes gpg), and the shipped " +
      "dome.sources fetch templates commit with `git -c " +
      "commit.gpgsign=false`. Affected: your own `git commit` and any " +
      "custom vault-side script that shells out to plain `git commit` — " +
      "those will try to sign, and a missing key or absent agent fails " +
      "the commit non-interactively.",
    recovery:
      "Informational — signing your own commits is your call. If an " +
      "unattended script's commits fail on signing, add `-c " +
      "commit.gpgsign=false` to its git commit invocation, or run " +
      "`git config --local commit.gpgsign false` in the vault to keep " +
      "human commits unsigned here too.",
  });
}

/**
 * True when `cron`'s earliest fire of the local day containing `now` is at
 * or before `now`. Malformed expressions return false (manifest crons are
 * validated upstream; a probe never throws).
 */
function cronFiredToday(cron: string, now: Date): boolean {
  let parsed;
  try {
    parsed = parseCron(cron);
  } catch {
    return false;
  }
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // nextFire scans from `after + 1 minute`, so back off one minute to make
  // 00:00 itself eligible.
  const firstFire = nextFire(
    parsed,
    new Date(startOfDay.getTime() - 60_000),
  );
  return (
    formatLocalDate(firstFire) === formatLocalDate(now) &&
    firstFire.getTime() <= now.getTime()
  );
}

/** The brief's schedule cron from the loaded registry, if any. */
function briefScheduleCron(registry: ProcessorRegistry): string | null {
  const brief = registry.get("dome.agent.brief");
  if (brief === undefined) return null;
  for (const trigger of brief.triggers) {
    if (trigger.kind === "schedule") return trigger.cron;
  }
  return null;
}

/**
 * Distinct local run dates (YYYY-MM-DD, newest first) for `dome.agent.brief`
 * from the run ledger. Bounded read — the probe needs at most the two most
 * recent days plus today.
 */
function briefRunDates(ledger: LedgerDb): ReadonlyArray<string> {
  const rows = queryRunSummaries(ledger, {
    processorId: "dome.agent.brief",
    limit: 50,
  });
  const dates: string[] = [];
  for (const row of rows) {
    const startedAt = new Date(row.startedAt);
    if (Number.isNaN(startedAt.getTime())) continue;
    const date = formatLocalDate(startedAt);
    if (!dates.includes(date)) dates.push(date);
  }
  return Object.freeze(dates);
}

function formatLocalDate(date: Date): string {
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatList(values: ReadonlyArray<string>): string {
  if (values.length === 0) return "";
  if (values.length === 1) return `'${values[0]}'`;
  return values.map((value) => `'${value}'`).join(", ");
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

function latestProblemRunFinding(row: RunRow): HealthFinding {
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
      "Run `dome init --refresh-instructions` to repair orientation shims " +
      "without overwriting user prose.",
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
