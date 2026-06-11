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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { computeAnswersSchemaHash } from "../../answers/db";
import type { LedgerDb } from "../../ledger/db";
import { computeLedgerSchemaHash } from "../../ledger/db";
import {
  latestActiveProblemRuns,
  orphanRuns,
  queryRunSummaries,
  type RunRow,
} from "../../ledger/runs";
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
import { canonicalVaultPath } from "../../core/vault-path";
import { graphWriteCovers } from "../core/capability-broker";
import { pathCapabilityMatches } from "../core/path-capabilities";
import type { ProcessorRegistry } from "../../processors/registry";
import type { ModelProviderProbeResult } from "./command-model-provider";

import { compareStrings } from "../../core/compare";

export const DEFAULT_ORPHAN_RUN_THRESHOLD_MS = 5 * 60 * 1000;
export const DEFAULT_PENDING_OUTBOX_THRESHOLD_MS = 30 * 60 * 1000;
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
  readonly modelProviderMissing: number;
  readonly modelProviderUnreachable: number;
  readonly modelProviderKeyMissing: number;
  readonly dailyPathMismatch: number;
  readonly sourcesTimeoutDefault: number;
  readonly dailyEditionNotCompiled: number;
  readonly dailyCalendarSourceMissing: number;
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

  const findings: HealthFinding[] = [
    ...storageSchema,
    ...capabilityGrants,
    ...capabilityGrantEntries,
    ...modelProvider,
    ...modelProviderProbe,
    ...dailyPathMismatch,
    ...sourcesTimeout,
    ...dailyEdition,
    ...failedOutbox.map(outboxFinding),
    ...stuckPendingOutbox.map(stuckPendingOutboxFinding),
    ...orphaned.map(orphanFinding),
    ...failedRuns.map(latestProblemRunFinding),
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
  const infoCount = findings.filter((f) => f.severity === "info").length;
  const count = (code: HealthFinding["code"]): number =>
    findings.filter((f) => f.code === code).length;

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
      failedOutbox: count("outbox.failed"),
      stuckPendingOutbox: count("outbox.pending-stuck"),
      orphanRuns: count("run.orphan"),
      failedRuns: count("run.latest-problem"),
      quarantinedProcessors: count("processor.quarantined"),
      projectionCacheDrift: count("projection.cache-key-drift"),
      adoptedRefDivergence: count("adopted-ref.diverged"),
      instructionDrift: count("instructions.drift"),
      operationalSchemaMismatch: count("operational.schema-mismatch"),
      capabilityGrantGaps: count("capability.grant-missing"),
      capabilityGrantEntryGaps: count("capability.grant-entry-missing"),
      modelProviderMissing: count("model.provider-missing"),
      modelProviderUnreachable: count("model.provider-unreachable"),
      modelProviderKeyMissing: count("model.provider-key-missing"),
      dailyPathMismatch: count("config.daily-path-mismatch"),
      sourcesTimeoutDefault: count("config.sources-timeout-default"),
      dailyEditionNotCompiled: count("daily.edition-not-compiled"),
      dailyCalendarSourceMissing: count("daily.calendar-source-missing"),
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
  const raw = config.subscriptions;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return Object.freeze([]);
  }
  return Object.freeze(
    Object.entries(raw as Record<string, unknown>)
      .filter(
        ([, entry]) =>
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>).enabled === true,
      )
      .map(([kind]) => kind)
      .sort(compareStrings),
  );
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
