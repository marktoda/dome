// engine/host/health/report: the finding → HealthReport fold and the
// code → summary-field bookkeeping table.
import type { HealthFinding, HealthReport, HealthSummary } from "./types";

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
  "task.duplicate-anchor": "duplicateTaskAnchors",
  "git.commit-signing": "gitCommitSigning",
  "outbox.recurring-failure": "recurringOutboxFailures",
  "questions.unreadable-backlog": "unreadableQuestions",
  "run.recurring-timeout": "recurringTimeouts",
} as const) satisfies Readonly<Record<HealthFinding["code"], keyof HealthSummary>>;

type CodeSummaryField =
  (typeof SUMMARY_FIELD_BY_CODE)[HealthFinding["code"]];

export function buildHealthReport(
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

