// cli/commands/check: unified read-only attention report.
//
// `dome check` is the normal "see why Dome wants attention" surface. It
// consolidates the user-facing parts of doctor / lint / inspect questions
// without creating a new mutation path. Recovery still flows through
// QuestionEffect rows and `dome resolve`.

import { basename } from "node:path";

import { getAdoptedRef, getCurrentBranch } from "../../adopted-ref";
import type { SourceRef } from "../../core/source-ref";
import { commitOid } from "../../core/source-ref";
import type { QuestionMetadata } from "../../core/effect";
import {
  collectHealthReport,
  collectOperationalSchemaReport,
  DEFAULT_ORPHAN_RUN_THRESHOLD_MS,
  type HealthFinding,
  type HealthReport,
} from "../../engine/health";
import { openVaultRuntime, type VaultRuntime } from "../../engine/vault-runtime";
import { emitRuntimeOpenFailure } from "../command-error";
import { FIRST_PARTY_MAINTENANCE_LOOPS } from "../../extensions/maintenance-loops";
import { queryRunSummaries } from "../../ledger/runs";
import {
  projectionCacheKeysChanged,
  projectionRequiresRebuild,
} from "../../projections/db";
import { queryDiagnostics } from "../../projections/diagnostics";
import { queryQuestionRecords } from "../../projections/questions";
import {
  countQuestionAutomationPolicies,
  questionAutomationLabel,
  questionAutomationPolicy,
  resolveQuestionCommand,
} from "../../question-resolution";
import {
  countAttentionDiagnostics,
  diagnosticDisposition,
  diagnosticRepairPath,
  formatSourceRefs,
  isSourceBackedDiagnostic,
  RECOVERY_SOURCE_REF_FORMAT,
  sortDiagnosticsByMessagePriority,
  summarizeDiagnosticDispositions,
  summarizeDiagnosticEffects,
  summarizeDiagnosticMessages,
  summarizeDiagnosticRepairPaths,
  type DiagnosticDispositionSummary,
  type DiagnosticMessageSummary,
  type DiagnosticRepairSummary,
  type DiagnosticSummary,
} from "../diagnostic-summary";
import { formatJson } from "../format";
import {
  formatCommand,
  formatSeverity,
  plural,
  truncateText,
} from "../human-output";
import {
  bullets,
  footer,
  headline,
  kv,
  nextActions,
  resolveCaps,
  section,
  statusValue,
  type Caps,
  type KvRow,
  type Status,
} from "../presenter";
import {
  collectMaintenanceLoopSummaries,
  formatMaintenanceLoopDetailLines,
  formatMaintenanceLoopSummaryLine,
  type MaintenanceLoopSummary,
} from "../maintenance-loop-summary";
import {
  nextActionsForCheck,
  type CliNextAction,
} from "../next-actions";
import {
  parseNonNegativeIntegerValue,
  parsePositiveIntegerValue,
} from "../parse-options";
import { resolveBundleRoots } from "./sync-shared";

import { resolveVaultPath } from "../resolve-vault";
const SCHEMA = "dome.check/v1";
const DEFAULT_LIMIT = 10;
const LOOP_RECENT_RUN_LIMIT = 25;
const EX_USAGE = 64;

export type RunCheckOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
  readonly engine?: boolean | undefined;
  readonly content?: boolean | undefined;
  readonly decisions?: boolean | undefined;
  readonly attention?: boolean | undefined;
  readonly limit?: string | number | boolean | undefined;
  readonly orphanThresholdMs?: string | number | undefined;
  readonly loops?: boolean | undefined;
};

type CheckScopes = {
  readonly engine: boolean;
  readonly content: boolean;
  readonly decisions: boolean;
};

type CheckReport = {
  readonly schema: typeof SCHEMA;
  readonly status: "ok" | "attention";
  readonly generatedAt: string;
  readonly scopes: CheckScopes;
  readonly projection: CheckProjectionReport;
  readonly engine: HealthReport | null;
  readonly content: CheckContentReport | null;
  readonly decisions: CheckDecisionReport | null;
  readonly maintenance_loops: ReadonlyArray<MaintenanceLoopSummary> | null;
  readonly next_actions: ReadonlyArray<CliNextAction>;
};

type CheckProjectionReport = {
  readonly stale: boolean;
  readonly cache_drift: boolean;
  readonly branch: string | null;
  readonly adopted: string | null;
};

type CheckContentReport = {
  readonly diagnostics: number;
  readonly content_diagnostics: number;
  readonly unlocated_diagnostics: number;
  readonly attention_diagnostics: number;
  readonly filtered_diagnostics: number;
  readonly filter: {
    readonly attention: boolean;
  };
  readonly summary: DiagnosticSummary;
  readonly message_summary: DiagnosticMessageSummary;
  readonly repair_summary: DiagnosticRepairSummary;
  readonly disposition_summary: DiagnosticDispositionSummary;
  readonly shownItems: number;
  readonly omittedItems: number;
  readonly items: ReadonlyArray<CheckDiagnosticItem>;
};

type CheckDiagnosticItem = {
  readonly severity: string;
  readonly code: string;
  readonly message: string;
  readonly repair_path: string;
  readonly repair_hint: string;
  readonly disposition: string;
  readonly disposition_hint: string;
  readonly source_refs: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type CheckDecisionReport = {
  readonly questions: number;
  readonly agent_safe_questions: number;
  readonly model_safe_questions: number;
  readonly owner_needed_questions: number;
  readonly shownItems: number;
  readonly omittedItems: number;
  readonly items: ReadonlyArray<CheckQuestionItem>;
};

type CheckQuestionItem = {
  readonly id: number;
  readonly question: string;
  readonly options: ReadonlyArray<string> | null;
  readonly resolveCommand: string;
  readonly metadata: QuestionMetadata | null;
  readonly automation_policy: string;
  readonly risk: string | null;
  readonly confidence: number | null;
  readonly recommended_answer: string | null;
  readonly owner_needed_reason: string | null;
  readonly processor_id: string;
  readonly source_refs: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

export async function runCheck(
  options: RunCheckOptions = {},
): Promise<number> {
  const limit = parseLimit(options.limit);
  if (limit === null) {
    console.error("dome check: --limit must be a positive integer.");
    return EX_USAGE;
  }
  const orphanThresholdMs = parseNonNegativeIntegerValue(
    options.orphanThresholdMs,
    DEFAULT_ORPHAN_RUN_THRESHOLD_MS,
  );
  if (orphanThresholdMs === null) {
    console.error(
      "dome check: --orphan-threshold-ms must be a non-negative integer.",
    );
    return EX_USAGE;
  }

  const vaultPath = resolveVaultPath(options.vault);
  const scopes = resolveScopes(options);
  const storageReport = collectOperationalSchemaReport({ vaultPath });
  if (storageReport.status === "unhealthy") {
    const report = reportFromUnavailableRuntime({
      generatedAt: storageReport.generatedAt,
      scopes: Object.freeze({
        engine: true,
        content: false,
        decisions: false,
      }),
      engine: storageReport,
    });
    printReport(report, options.json === true, {
      showLoopDetails: options.loops === true,
      vaultPath,
    });
    return 0;
  }

  const bundleRoots = resolveBundleRoots({
    vaultPath,
    bundlesRoot: options.bundlesRoot,
  });
  const runtimeResult = await openVaultRuntime({ vaultPath, ...bundleRoots });
  if (!runtimeResult.ok) {
    return emitRuntimeOpenFailure({
      command: "check",
      json: options.json === true,
      errorKind: runtimeResult.error.kind,
    });
  }
  const runtime = runtimeResult.value;

  try {
    const projection = await collectProjectionReport({
      vaultPath: runtime.path,
      runtime,
    });
    const diagnosticRows = queryDiagnostics(runtime.projectionDb);
    const unresolvedQuestions = queryQuestionRecords(runtime.projectionDb, {
      resolved: false,
    });
    const engine = scopes.engine
      ? await collectHealthReport({
          vaultPath: runtime.path,
          projection: runtime.projectionDb,
          ledger: runtime.ledgerDb,
          outbox: runtime.outboxDb,
          executionState: runtime.processorRuntime.executionState,
          extensions: runtime.extensions,
          processorVersions: runtime.processorVersions,
          capabilityPolicyHash: runtime.capabilityPolicyHash,
          registry: runtime.registry,
          resolveGrants: runtime.resolveGrants,
          extensionConfigFor: runtime.extensionConfigFor,
          modelProviderConfigured: runtime.modelProvider !== undefined,
          externalHandlerTimeoutConfigured:
            runtime.config.engine.externalHandlerTimeoutMs !== undefined,
          orphanRunThresholdMs: orphanThresholdMs,
        })
      : null;
    const content = scopes.content
      ? collectContentReport({
          diagnostics: diagnosticRows,
          attentionOnly: contentAttentionOnlyForRender(options),
          limit,
        })
      : null;
    const decisions = scopes.decisions
      ? collectDecisionReport({
          questions: unresolvedQuestions,
          limit,
        })
      : null;
    const activeProcessorIds = new Set(
      runtime.registry.all().map((processor) => processor.id),
    );
    const maintenance_loops = collectMaintenanceLoopSummaries({
      loops: FIRST_PARTY_MAINTENANCE_LOOPS,
      activeProcessorIds,
      diagnosticsByProcessor: (processorId) =>
        queryDiagnostics(runtime.projectionDb, { processorId }),
      unresolvedQuestions,
      runsByProcessor: (processorId) =>
        queryRunSummaries(runtime.ledgerDb, {
          processorId,
          limit: LOOP_RECENT_RUN_LIMIT,
        }),
    });
    const report = buildReport({
      generatedAt: engine?.generatedAt ?? new Date().toISOString(),
      scopes,
      projection,
      engine,
      content,
      decisions,
      maintenanceLoops: maintenance_loops,
    });
    printReport(report, options.json === true, {
      showLoopDetails: options.loops === true,
      vaultPath,
    });
    return 0;
  } finally {
    await runtime.close();
  }
}

function resolveScopes(options: RunCheckOptions): CheckScopes {
  const explicit =
    options.engine === true ||
    options.content === true ||
    options.decisions === true;
  return Object.freeze({
    engine: explicit ? options.engine === true : true,
    content: explicit ? options.content === true : true,
    decisions: explicit ? options.decisions === true : true,
  });
}

function contentAttentionOnlyForRender(options: RunCheckOptions): boolean {
  if (options.attention === true) return true;
  if (options.json === true) return false;
  return options.content !== true;
}

function collectContentReport(opts: {
  readonly diagnostics: ReturnType<typeof queryDiagnostics>;
  readonly attentionOnly: boolean;
  readonly limit: number;
}): CheckContentReport {
  const contentDiagnostics = opts.diagnostics.filter(isSourceBackedDiagnostic);
  const unlocatedDiagnostics = opts.diagnostics.length -
    contentDiagnostics.length;
  const filteredDiagnostics = opts.attentionOnly
    ? contentDiagnostics.filter((diagnostic) => diagnostic.severity !== "info")
    : contentDiagnostics;
  const repairOrderedDiagnostics =
    sortDiagnosticsByMessagePriority(filteredDiagnostics);
  const items = Object.freeze(
    repairOrderedDiagnostics.slice(0, opts.limit).map((diagnostic) => {
      const repair = diagnosticRepairPath(diagnostic);
      const disposition = diagnosticDisposition(diagnostic);
      return Object.freeze({
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: diagnostic.message,
        repair_path: repair.repair_path,
        repair_hint: repair.repair_hint,
        disposition: disposition.disposition,
        disposition_hint: disposition.disposition_hint,
        source_refs: formatSourceRefs(
          diagnostic.sourceRefs,
          RECOVERY_SOURCE_REF_FORMAT,
        ),
        sourceRefs: diagnostic.sourceRefs,
      });
    }),
  );
  return Object.freeze({
    diagnostics: opts.diagnostics.length,
    content_diagnostics: contentDiagnostics.length,
    unlocated_diagnostics: unlocatedDiagnostics,
    attention_diagnostics: countAttentionDiagnostics(contentDiagnostics),
    filtered_diagnostics: filteredDiagnostics.length,
    filter: Object.freeze({
      attention: opts.attentionOnly,
    }),
    summary: summarizeDiagnosticEffects(
      filteredDiagnostics,
      opts.limit,
      { sourceRefs: RECOVERY_SOURCE_REF_FORMAT },
    ),
    message_summary: summarizeDiagnosticMessages(
      filteredDiagnostics,
      opts.limit,
      { sourceRefs: RECOVERY_SOURCE_REF_FORMAT },
    ),
    repair_summary: summarizeDiagnosticRepairPaths(
      filteredDiagnostics,
      opts.limit,
      { sourceRefs: RECOVERY_SOURCE_REF_FORMAT },
    ),
    disposition_summary: summarizeDiagnosticDispositions(
      filteredDiagnostics,
      opts.limit,
      { sourceRefs: RECOVERY_SOURCE_REF_FORMAT },
    ),
    shownItems: items.length,
    omittedItems: Math.max(0, filteredDiagnostics.length - items.length),
    items,
  });
}

function collectDecisionReport(opts: {
  readonly questions: ReturnType<typeof queryQuestionRecords>;
  readonly limit: number;
}): CheckDecisionReport {
  const items = Object.freeze(
    opts.questions.slice(0, opts.limit).map((question) => {
      const options = question.effect.options ?? null;
      const metadata = question.effect.metadata ?? null;
      return Object.freeze({
        id: question.id,
        question: question.effect.question,
        options,
        resolveCommand: resolveQuestionCommand({
          id: question.id,
          options,
        }),
        metadata,
        automation_policy: questionAutomationPolicy(metadata),
        risk: metadata?.risk ?? null,
        confidence: metadata?.confidence ?? null,
        recommended_answer: metadata?.recommendedAnswer ?? null,
        owner_needed_reason: metadata?.ownerNeededReason ?? null,
        processor_id: question.processorId,
        source_refs: formatSourceRefs(
          question.effect.sourceRefs,
          RECOVERY_SOURCE_REF_FORMAT,
        ),
        sourceRefs: question.effect.sourceRefs,
      });
    }),
  );
  const policyCounts = countQuestionAutomationPolicies(
    opts.questions.map((question) => question.effect.metadata),
  );
  return Object.freeze({
    questions: opts.questions.length,
    agent_safe_questions: policyCounts.agentSafe,
    model_safe_questions: policyCounts.modelSafe,
    owner_needed_questions: policyCounts.ownerNeeded,
    shownItems: items.length,
    omittedItems: Math.max(0, opts.questions.length - items.length),
    items,
  });
}

function buildReport(input: {
  readonly generatedAt: string;
  readonly scopes: CheckScopes;
  readonly projection: CheckProjectionReport;
  readonly engine: HealthReport | null;
  readonly content: CheckContentReport | null;
  readonly decisions: CheckDecisionReport | null;
  readonly maintenanceLoops: ReadonlyArray<MaintenanceLoopSummary> | null;
}): CheckReport {
  // Info-severity engine findings are FYI (e.g. daily.calendar-source-missing
  // on a deliberately calendar-less vault) and must not hold check in
  // "attention" — mirror the engine report's own ok/unhealthy rule.
  const engineFindings = input.engine === null || input.engine === undefined
    ? 0
    : input.engine.summary.errorCount + input.engine.summary.warningCount;
  const attentionDiagnostics = input.content?.attention_diagnostics ?? 0;
  const questions = input.decisions?.questions ?? 0;
  return Object.freeze({
    schema: SCHEMA,
    status:
      input.projection.stale ||
      engineFindings > 0 ||
      attentionDiagnostics > 0 ||
      questions > 0
      ? "attention"
      : "ok",
    generatedAt: input.generatedAt,
    scopes: input.scopes,
    projection: input.projection,
    engine: input.engine,
    content: input.content,
    decisions: input.decisions,
    maintenance_loops: input.maintenanceLoops,
    next_actions: nextActionsForCheck({
      engineFindings,
      projectionStale: input.projection.stale,
      diagnostics: attentionDiagnostics,
      diagnosticsAlreadyBounded:
        input.scopes.content && input.content?.filter.attention === true,
      questions,
      firstQuestionId: input.decisions?.items[0]?.id ?? null,
      firstQuestionOptions: input.decisions?.items[0]?.options ?? null,
    }),
  });
}

function reportFromUnavailableRuntime(input: {
  readonly generatedAt: string;
  readonly scopes: CheckScopes;
  readonly engine: HealthReport;
}): CheckReport {
  return buildReport({
    generatedAt: input.generatedAt,
    scopes: input.scopes,
    projection: Object.freeze({
      stale: false,
      cache_drift: false,
      branch: null,
      adopted: null,
    }),
    engine: input.engine,
    content: null,
    decisions: null,
    maintenanceLoops: null,
  });
}

function printReport(
  report: CheckReport,
  json: boolean,
  options: { readonly showLoopDetails: boolean; readonly vaultPath: string },
): void {
  if (json) {
    console.log(formatJson(report));
    return;
  }
  const caps = resolveCaps();
  const lines = renderCheckReport(report, { ...options, caps });
  console.log(lines.join("\n"));
}

function renderCheckReport(
  report: CheckReport,
  options: { readonly showLoopDetails: boolean; readonly vaultPath: string; readonly caps: Caps },
): ReadonlyArray<string> {
  const caps = options.caps;
  const glance = (label: string, st: Status): KvRow => ({
    label,
    value: statusValue(st, caps),
    tone: "plain",
  });

  const headStatus = checkHeadlineStatus(report);
  const lines: string[] = [
    headline({ cmd: "check", context: basename(options.vaultPath) }, headStatus, caps),
  ];

  lines.push(...section("Next", nextActions(report.next_actions, caps), caps));

  lines.push(
    ...section(
      "At a glance",
      kv(
        [
          glance("status", checkOverallStatus(report)),
          glance("projection", projectionStatus(report.projection)),
          glance("engine", engineStatus(report.engine)),
          {
            label: "content",
            value: formatContent(report.content),
            tone: "plain",
          },
          {
            label: "decisions",
            value: formatDecisions(report.decisions),
            tone: "plain",
          },
          {
            label: "loops",
            value: formatLoops(report.maintenance_loops),
            tone: "plain",
          },
        ],
        caps,
      ),
      caps,
    ),
  );

  if (options.showLoopDetails) {
    lines.push(
      ...section("Loops", loopDetailLines(report.maintenance_loops, caps), caps),
    );
  }

  lines.push(...section("Engine", findingLines(report.engine?.findings ?? [], caps), caps));
  lines.push(...section("Content", diagnosticLines(report.content, caps), caps));
  lines.push(...section("Decisions", questionLines(report.decisions, caps), caps));

  const footerStatus: Status = report.status === "ok"
    ? { tone: "ok", label: "all clear" }
    : { tone: "warn", label: "needs attention" };
  lines.push(...footer(footerStatus, caps));

  return Object.freeze(lines);
}

function checkHeadlineStatus(report: CheckReport): Status {
  if (report.projection.stale) return { tone: "warn", label: "needs sync" };
  if (report.status === "ok") return { tone: "ok", label: "ok" };
  return { tone: "warn", label: "needs attention" };
}

function checkOverallStatus(report: CheckReport): Status {
  if (report.status === "ok") return { tone: "ok", label: "ok" };
  return { tone: "warn", label: "attention" };
}

function projectionStatus(report: CheckProjectionReport): Status {
  if (!report.stale) return { tone: "ok", label: "fresh" };
  return { tone: "warn", label: report.cache_drift ? "stale (cache drift)" : "stale" };
}

function engineStatus(report: HealthReport | null): Status {
  if (report === null) return { tone: "muted", label: "skipped" };
  if (report.status === "ok") {
    return report.summary.infoCount === 0
      ? { tone: "ok", label: "ok" }
      : { tone: "ok", label: `ok · ${report.summary.infoCount} info` };
  }
  return {
    tone: "warn",
    label: `${report.summary.findingCount} finding(s) · ${report.summary.errorCount} error · ${report.summary.warningCount} warning · ${report.summary.infoCount} info`,
  };
}

async function collectProjectionReport(input: {
  readonly vaultPath: string;
  readonly runtime: VaultRuntime;
}): Promise<CheckProjectionReport> {
  const branch = await getCurrentBranch(input.vaultPath);
  const adopted = branch === null
    ? null
    : await getAdoptedRef(input.vaultPath, branch);
  const cache_drift = projectionCacheKeysChanged(input.runtime.projectionDb, {
    extensionSet: input.runtime.extensions,
    processorVersions: input.runtime.processorVersions,
    capabilityPolicyHash: input.runtime.capabilityPolicyHash,
  });
  const stale = adopted === null
    ? cache_drift
    : projectionRequiresRebuild(input.runtime.projectionDb, {
        adoptedCommit: commitOid(adopted),
        extensionSet: input.runtime.extensions,
        processorVersions: input.runtime.processorVersions,
        capabilityPolicyHash: input.runtime.capabilityPolicyHash,
      });
  return Object.freeze({
    stale,
    cache_drift,
    branch,
    adopted,
  });
}

function loopDetailLines(
  loops: ReadonlyArray<MaintenanceLoopSummary> | null,
  caps: Caps,
): ReadonlyArray<string> {
  if (loops === null) return [];
  return formatMaintenanceLoopDetailLines(loops, caps);
}

function formatContent(report: CheckContentReport | null): string {
  if (report === null) return "skipped";
  const attention =
    report.diagnostics === 0
      ? ""
      : ` · ${plural(report.attention_diagnostics, "attention item")}`;
  const unlocated =
    report.unlocated_diagnostics === 0
      ? ""
      : ` · ${plural(report.unlocated_diagnostics, "unlocated item")}`;
  const filter =
    report.filter.attention && report.diagnostics > 0
      ? formatAttentionFilter(report)
      : "";
  return `${plural(report.diagnostics, "diagnostic")}${attention}${unlocated}${filter}`;
}

function formatAttentionFilter(report: CheckContentReport): string {
  if (report.filtered_diagnostics === 0) {
    return " · showing none";
  }
  if (report.items.length >= report.filtered_diagnostics) {
    return ` · showing ${plural(report.filtered_diagnostics, "attention item")}`;
  }
  return ` · showing ${report.items.length}/${report.filtered_diagnostics} attention`;
}

function formatDecisions(report: CheckDecisionReport | null): string {
  if (report === null) return "skipped";
  const agentReady = report.agent_safe_questions + report.model_safe_questions;
  if (report.questions === 0) return "0 open questions";
  return `${plural(report.questions, "open question")} · ${agentReady} agent/model-safe · ${report.owner_needed_questions} owner-needed`;
}

function formatLoops(
  loops: ReadonlyArray<MaintenanceLoopSummary> | null,
): string {
  if (loops === null) return "unavailable";
  return formatMaintenanceLoopSummaryLine(loops);
}

function findingLines(findings: ReadonlyArray<HealthFinding>, _caps: Caps): ReadonlyArray<string> {
  if (findings.length === 0) return [];
  const lines: string[] = [];
  for (const finding of findings) {
    lines.push(
      `  - [${formatSeverity(finding.severity)}] ${finding.code}: ${finding.message}`,
    );
    lines.push(`    recovery: ${finding.recovery}`);
  }
  return lines;
}

function diagnosticLines(
  report: CheckContentReport | null,
  caps: Caps,
): ReadonlyArray<string> {
  const items = report?.items ?? [];
  if (items.length === 0) return [];
  const lines: string[] = [];
  lines.push(`  showing ${items.length}/${report?.filtered_diagnostics ?? items.length}`);
  for (const [disposition, groupItems] of groupDiagnosticsByDisposition(items)) {
    lines.push(``, `  ${formatDispositionHeading(disposition, groupItems.length)}`);
    for (const item of groupItems) {
      lines.push(
        `    - [${formatSeverity(item.severity)}] ${item.code}: ${truncateText(item.message, 160)}`,
      );
      lines.push(`      source: ${item.source_refs}`);
      lines.push(`      fix: ${item.repair_path} - ${item.repair_hint}`);
    }
  }
  appendDiagnosticPatterns(lines, report, caps);
  appendMoreLine(
    lines,
    report?.filtered_diagnostics ?? 0,
    items.length,
    "diagnostics",
  );
  return lines;
}

function appendDiagnosticPatterns(
  lines: string[],
  report: CheckContentReport | null,
  caps: Caps,
): void {
  if (report === null) return;
  const patterns: string[] = [];
  const repeatedMessages = report.message_summary.groups.filter((group) =>
    group.count > 1
  );
  for (const group of repeatedMessages) {
    patterns.push(
      `${group.count}x [${formatSeverity(group.severity)}] ${group.code}: ${group.message}`,
    );
  }
  const repairGroups = report.repair_summary.groups.filter((group) =>
    group.count > 1
  );
  for (const group of repairGroups) {
    patterns.push(`${group.count}x ${group.repair_path}: ${group.repair_hint}`);
  }
  if (patterns.length === 0) return;
  // Patterns is a sub-section nested inside the Content section body.
  // section() adds 2-space indent to each body line and prefixes an
  // ALLCAPS title. Because these lines will themselves be indented
  // another 2 spaces by the outer Content section, they end up at the
  // correct visual nesting depth.
  lines.push(...section("Patterns", bullets(patterns, caps), caps));
}

function questionLines(
  report: CheckDecisionReport | null,
  _caps: Caps,
): ReadonlyArray<string> {
  const items = report?.items ?? [];
  if (items.length === 0) return [];
  const lines: string[] = [];
  for (const item of items) {
    const options = item.options === null ? "" : ` options: ${item.options.join(", ")}`;
    lines.push(`  - #${item.id}: ${item.question}${options}`);
    lines.push(`    policy: ${questionAutomationLabel(item.metadata)}`);
    if (item.recommended_answer !== null) {
      lines.push(`    recommended: ${item.recommended_answer}`);
    }
    if (item.owner_needed_reason !== null) {
      lines.push(`    owner-needed: ${item.owner_needed_reason}`);
    }
    lines.push(`    source: ${item.source_refs}`);
    lines.push(`    resolve: ${formatCommand(item.resolveCommand)}`);
  }
  appendMoreLine(lines, report?.questions ?? 0, items.length, "questions");
  return lines;
}

function appendMoreLine(
  lines: string[],
  total: number,
  shown: number,
  label: string,
): void {
  const remaining = total - shown;
  if (remaining <= 0) return;
  lines.push(
    `  ... ${remaining} more ${label} (use --limit ${total} to show all)`,
  );
}

function groupDiagnosticsByDisposition(
  items: ReadonlyArray<CheckDiagnosticItem>,
): ReadonlyArray<readonly [string, ReadonlyArray<CheckDiagnosticItem>]> {
  const order = ["owner-needed", "agent-fixable", "auto-fixable", "noise"];
  const groups = new Map<string, CheckDiagnosticItem[]>();
  for (const item of items) {
    const group = groups.get(item.disposition) ?? [];
    group.push(item);
    groups.set(item.disposition, group);
  }
  return Object.freeze(
    [...groups.entries()].sort(
      ([a], [b]) => order.indexOf(a) - order.indexOf(b),
    ),
  );
}

function formatDispositionHeading(disposition: string, count: number): string {
  const label = disposition.replace(/-/g, " ");
  return `${label} (${plural(count, "item")})`;
}

function parseLimit(raw: string | number | boolean | undefined): number | null {
  return parsePositiveIntegerValue(raw, DEFAULT_LIMIT);
}
