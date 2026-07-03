// engine/host/health/types: the health finding/summary/report types, the
// HealthInputs context, and the shared threshold constants. No logic.
import type {
  ManifestGrantEntryRequirement,
} from "../../../extensions/manifest-schema";
import type { LedgerDb } from "../../../ledger/db";
import type { RunRow } from "../../../ledger/runs";
import type { OutboxDb } from "../../../outbox/db";
import type { OutboxRow } from "../../../outbox/dispatch";
import type { ProjectionDb } from "../../../projections/db";
import type {
  ProcessorExecutionState,
} from "../../../processors/execution-state";
import type { ProcessorRegistry } from "../../../processors/registry";
import type { Capability } from "../../../core/processor";
import type { ModelProviderProbeResult } from "../command-model-provider";

/** The grant-entry kinds a manifest can require (capability probes). */
export type GrantEntryKind = "read" | "patch.auto" | "graph.write";

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
 * while still firing early on a genuine wedge (e.g. a whole-vault adoption
 * scan like dome.markdown.lint-supersession timing out ~30+ times).
 */
export const DEFAULT_RECURRING_TIMEOUT_THRESHOLD = 2;
/**
 * How many recent runs the recurring-timeout probe scans. Bounded so the
 * health tick stays cheap; large enough to catch a minute-cadence loop.
 */
export const RECURRING_TIMEOUT_SCAN_LIMIT = 200;
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

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
      /** Terse one-line claim (no consequence clause); absent when not authored. */
      readonly summary?: string;
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
      /** Terse one-line claim (no consequence clause); absent when not authored. */
      readonly summary?: string;
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
      /** Terse one-line claim (no consequence clause); absent when not authored. */
      readonly summary?: string;
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
      readonly code: "task.duplicate-anchor";
      readonly severity: "warning";
      readonly subject: "tasks";
      readonly id: string;
      readonly message: string;
      readonly recovery: string;
      readonly taskAnchor: {
        readonly anchor: string;
        readonly occurrences: ReadonlyArray<{
          readonly path: string;
          readonly line: number;
          readonly text: string;
        }>;
      };
    }
  | {
      readonly code: "git.commit-signing";
      readonly severity: "info";
      readonly subject: "git";
      readonly id: "commit_gpgsign";
      readonly message: string;
      readonly recovery: string;
    }
  | {
      readonly code: "ledger.oversized";
      readonly severity: "info";
      readonly subject: "runs";
      readonly id: "runs_db";
      readonly message: string;
      readonly recovery: string;
      readonly ledger: {
        readonly path: string;
        readonly sizeBytes: number;
        readonly thresholdBytes: number;
      };
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
  readonly duplicateTaskAnchors: number;
  readonly gitCommitSigning: number;
  readonly recurringOutboxFailures: number;
  readonly unreadableQuestions: number;
  readonly recurringTimeouts: number;
  readonly ledgerOversized: number;
};

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

/**
 * The single context `collectHealthReport` consumes — built from an open
 * runtime by `healthInputsFromRuntime` (engine/host/health-inputs), with the
 * doctor-only probes (model provider, commit signing) and threshold/now
 * overrides set by the caller. Replaces the former 27-field inline options
 * object: one named seam shared by `dome check` and `dome doctor`.
 */
export type HealthInputs = {
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
};
