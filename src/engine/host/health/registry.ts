// engine/host/health/registry: the probe registry and the public
// collectHealthReport / collectOperationalSchemaReport entry points. The list
// IS the single ordered inventory of probes; collectHealthReport normalizes the
// context once and folds the registry through buildHealthReport.
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  latestActiveProblemRuns,
  orphanRuns,
  ORPHAN_RECOVERY_EXCLUDED_PROCESSOR_PREFIXES,
  queryRunSummaries,
} from "../../../ledger/runs";
import { countUnrehydratableQuestions } from "../../../projections/questions";
import { queryOutbox } from "../../../outbox/dispatch";
import { projectionCacheKeysChanged } from "../../../projections/db";
import {
  DEFAULT_ORPHAN_RUN_THRESHOLD_MS,
  DEFAULT_PENDING_OUTBOX_THRESHOLD_MS,
  RECURRING_TIMEOUT_SCAN_LIMIT,
  type HealthFinding,
  type HealthInputs,
  type HealthReport,
} from "./types";
import { buildHealthReport } from "./report";
import {
  capabilityGrantEntryFindings,
  capabilityGrantFindings,
  capabilityGrantStarvationFindings,
} from "./capability";
import {
  modelProviderFindings,
  modelProviderProbeFindings,
} from "./model-provider";
import {
  dailyPathMismatchFindings,
  sourcesFetchScriptFindings,
  sourcesHandlerTimeoutFindings,
} from "./sources";
import {
  briefRunDates,
  briefScheduleCron,
  commitSigningFinding,
  dailyEditionFindings,
  duplicateTaskAnchorFindings,
  markdownFilesForTaskAnchorScan,
} from "./daily";
import {
  isStuckPendingOutbox,
  outboxFinding,
  recurringOutboxFailureFindings,
  stuckPendingOutboxFinding,
  unreadableQuestionBacklogFindings,
} from "./outbox";
import {
  adoptedRefDivergenceFinding,
  collectOperationalSchemaFindings,
  instructionDriftFindings,
  ledgerOversizedFinding,
  latestProblemRunFinding,
  orphanFinding,
  projectionCacheDriftFinding,
  quarantineFinding,
  recurringTimeoutFindings,
} from "./operational";

/**
 * `HealthInputs` with `now` and the always-defaulted thresholds resolved, so
 * probes read concrete values. `collectHealthReport` normalizes once.
 */
type ProbeContext = HealthInputs & {
  readonly now: Date;
  readonly orphanRunThresholdMs: number;
  readonly pendingOutboxThresholdMs: number;
};

/**
 * A health probe: read the context, self-gate (a probe whose inputs are absent
 * returns no findings), and return its findings. The pure detection functions
 * keep their small focused inputs; each probe here is the thin adapter that
 * derives those inputs from the context. Sync or async (the git/divergence
 * probe is async); `collectHealthReport` awaits all.
 */
type HealthProbe = (
  ctx: ProbeContext,
) => ReadonlyArray<HealthFinding> | Promise<ReadonlyArray<HealthFinding>>;

/**
 * The probe registry — the single ordered list of every health probe. Order is
 * the emitted `findings` order (and was the order of the former hand-spread
 * `findings` array), so `dome doctor --json` / `dome check` output is unchanged.
 * Adding a probe is one entry here plus its detection fn and its
 * `SUMMARY_FIELD_BY_CODE` row; there is no longer a separate conditional-compute
 * blob and findings-spread to keep in sync.
 */
const HEALTH_PROBES: ReadonlyArray<HealthProbe> = [
  (c) => collectOperationalSchemaFindings(c.vaultPath),
  (c) =>
    c.registry === undefined || c.resolveGrants === undefined
      ? []
      : capabilityGrantFindings({
          registry: c.registry,
          resolveGrants: c.resolveGrants,
        }),
  (c) =>
    c.registry === undefined || c.resolveGrants === undefined
      ? []
      : capabilityGrantEntryFindings({
          registry: c.registry,
          resolveGrants: c.resolveGrants,
          requirements: c.doctorGrantEntries ?? [],
        }),
  (c) =>
    c.registry === undefined || c.resolveGrants === undefined
      ? []
      : capabilityGrantStarvationFindings({
          registry: c.registry,
          resolveGrants: c.resolveGrants,
          requirements: c.doctorGrantEntries ?? [],
          ...(c.extensionIdFor !== undefined
            ? { extensionIdFor: c.extensionIdFor }
            : {}),
        }),
  (c) =>
    c.registry === undefined || c.resolveGrants === undefined
      ? []
      : modelProviderFindings({
          registry: c.registry,
          resolveGrants: c.resolveGrants,
          modelProviderConfigured: c.modelProviderConfigured === true,
        }),
  (c) =>
    c.modelProviderProbe === undefined
      ? []
      : modelProviderProbeFindings(c.modelProviderProbe),
  (c) =>
    c.extensionConfigFor === undefined
      ? []
      : dailyPathMismatchFindings({
          extensions: c.extensions,
          extensionConfigFor: c.extensionConfigFor,
        }),
  (c) =>
    c.extensionConfigFor === undefined
      ? []
      : sourcesHandlerTimeoutFindings({
          extensions: c.extensions,
          extensionConfigFor: c.extensionConfigFor,
          externalHandlerTimeoutConfigured:
            c.externalHandlerTimeoutConfigured === true,
        }),
  (c) =>
    c.extensionConfigFor === undefined
      ? []
      : sourcesFetchScriptFindings({
          extensions: c.extensions,
          extensionConfigFor: c.extensionConfigFor,
          scriptIsFile: (scriptPath) => {
            const resolved = isAbsolute(scriptPath)
              ? scriptPath
              : join(c.vaultPath, scriptPath);
            try {
              return statSync(resolved).isFile();
            } catch {
              return false;
            }
          },
        }),
  (c) =>
    c.registry === undefined
      ? []
      : dailyEditionFindings({
          now: c.now,
          briefCron: briefScheduleCron(c.registry),
          briefRunDates: briefRunDates(c.ledger),
          calendarFileExists: (date) =>
            existsSync(join(c.vaultPath, "sources", "calendar", `${date}.md`)),
        }),
  (c) =>
    c.extensions.some((e) => e.name === "dome.daily")
      ? duplicateTaskAnchorFindings({
          files: markdownFilesForTaskAnchorScan(c.vaultPath),
        })
      : [],
  (c) => (c.commitSigningEnabled === true ? [commitSigningFinding()] : []),
  // Outbox failures: failed rows and the recurring-failure root cause share one
  // `queryOutbox(failed)` read, emitted in the former spread order.
  (c) => {
    const failedOutbox = queryOutbox(c.outbox, { status: "failed" });
    return [
      ...failedOutbox.map(outboxFinding),
      ...recurringOutboxFailureFindings({
        failedOutbox,
        now: c.now,
        ...(c.recurringOutboxFailureThresholdMs !== undefined
          ? { thresholdMs: c.recurringOutboxFailureThresholdMs }
          : {}),
      }),
    ];
  },
  (c) =>
    queryOutbox(c.outbox, { status: "pending" })
      .filter((row) => isStuckPendingOutbox(row, c.now, c.pendingOutboxThresholdMs))
      .map(stuckPendingOutboxFinding),
  // Self-referential orphan containment (Task 4b): the run.orphan finding is a
  // recovery surface, so it excludes the dome.health recovery processors' own
  // minute-cadence runs — otherwise the orphan-run detector raises a finding
  // about itself. A genuinely stuck health run is still visible via
  // `dome inspect orphan-runs` (which calls orphanRuns unfiltered).
  (c) =>
    orphanRuns(c.ledger, c.orphanRunThresholdMs, c.now, {
      excludeProcessorIdPrefixes: ORPHAN_RECOVERY_EXCLUDED_PROCESSOR_PREFIXES,
    }).map(orphanFinding),
  // A latest-failure finding for a processor that is no longer registered
  // (bundle retired or disabled) can never be superseded by a newer run — it
  // would hold attention_required hostage forever (the stale
  // dome.intake.synthesize-rollup failure of 2026-06-08). Registry absent (no
  // bundles resolvable in this call shape) → no filtering.
  (c) =>
    latestActiveProblemRuns(c.ledger)
      .filter(
        (row) =>
          c.registry === undefined ||
          c.registry.get(row.processorId) !== undefined,
      )
      .map(latestProblemRunFinding),
  (c) =>
    recurringTimeoutFindings({
      recentTimedOutRuns: queryRunSummaries(c.ledger, {
        status: "timed_out",
        limit: RECURRING_TIMEOUT_SCAN_LIMIT,
      }),
      ...(c.recurringTimeoutThreshold !== undefined
        ? { threshold: c.recurringTimeoutThreshold }
        : {}),
    }),
  (c) => c.executionState.quarantines().map(quarantineFinding),
  (c) =>
    unreadableQuestionBacklogFindings({
      unrehydratableCount: countUnrehydratableQuestions(c.projection),
    }),
  (c) =>
    projectionCacheKeysChanged(c.projection, {
      extensionSet: c.extensions,
      processorVersions: c.processorVersions,
      capabilityPolicyHash: c.capabilityPolicyHash,
    })
      ? [projectionCacheDriftFinding()]
      : [],
  async (c) => {
    const divergence = await adoptedRefDivergenceFinding(c.vaultPath);
    return divergence === null ? [] : [divergence];
  },
  (c) => instructionDriftFindings(c.vaultPath),
  (c) => {
    const runsDbPath = join(c.vaultPath, ".dome", "state", "runs.db");
    let sizeBytes: number;
    try {
      sizeBytes = statSync(runsDbPath).size;
    } catch {
      return [];
    }
    const finding = ledgerOversizedFinding({ path: runsDbPath, sizeBytes });
    return finding === null ? [] : [finding];
  },
];

export async function collectHealthReport(
  opts: HealthInputs,
): Promise<HealthReport> {
  const ctx: ProbeContext = {
    ...opts,
    now: opts.now ?? new Date(),
    orphanRunThresholdMs:
      opts.orphanRunThresholdMs ?? DEFAULT_ORPHAN_RUN_THRESHOLD_MS,
    pendingOutboxThresholdMs:
      opts.pendingOutboxThresholdMs ?? DEFAULT_PENDING_OUTBOX_THRESHOLD_MS,
  };
  const found = await Promise.all(HEALTH_PROBES.map((probe) => probe(ctx)));
  return buildHealthReport(found.flat(), ctx.now);
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

