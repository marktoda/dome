// cli/commands/check: unified read-only attention report.
//
// `dome check` is the normal "see why Dome wants attention" surface. It
// consolidates the user-facing parts of doctor / lint / inspect questions
// without creating a new mutation path. Recovery still flows through
// QuestionEffect rows and `dome resolve`.

import { resolve } from "node:path";

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
import { FIRST_PARTY_MAINTENANCE_LOOPS } from "../../extensions/maintenance-loops";
import { queryRuns } from "../../ledger/runs";
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
  collectMaintenanceLoopSummaries,
  formatMaintenanceLoopDetailLines,
  formatMaintenanceLoopSummaryLine,
  type MaintenanceLoopSummary,
} from "../maintenance-loop-summary";
import {
  formatCliNextAction,
  nextActionsForCheck,
  type CliNextAction,
} from "../next-actions";
import {
  parseNonNegativeIntegerValue,
  parsePositiveIntegerValue,
} from "../parse-options";
import { resolveBundleRoots } from "./sync-shared";

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

  const vaultPath = resolve(options.vault ?? process.cwd());
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
    });
    return 0;
  }

  const bundleRoots = resolveBundleRoots({
    vaultPath,
    bundlesRoot: options.bundlesRoot,
  });
  const runtimeResult = await openVaultRuntime({ vaultPath, ...bundleRoots });
  if (!runtimeResult.ok) {
    console.error(
      `dome check: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` first to initialize the vault.`,
    );
    return 1;
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
          modelProviderConfigured: runtime.modelProvider !== undefined,
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
        queryRuns(runtime.ledgerDb, {
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
  const engineFindings = input.engine?.summary.findingCount ?? 0;
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
  options: { readonly showLoopDetails: boolean },
): void {
  if (json) {
    console.log(formatJson(report));
    return;
  }
  console.log("DOME check");
  console.log(`status    ${report.status}`);
  console.log(`projection ${formatProjection(report.projection)}`);
  console.log(`engine    ${formatEngine(report.engine)}`);
  console.log(`content   ${formatContent(report.content)}`);
  console.log(`decisions ${formatDecisions(report.decisions)}`);
  console.log(`loops     ${formatLoops(report.maintenance_loops)}`);
  if (options.showLoopDetails) {
    printLoopDetails(report.maintenance_loops);
  }
  printFindings(report.engine?.findings ?? []);
  printDiagnostics(report.content);
  printQuestions(report.decisions);
  printNextActions(report.next_actions);
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

function printLoopDetails(
  loops: ReadonlyArray<MaintenanceLoopSummary> | null,
): void {
  if (loops === null) return;
  console.log("");
  console.log("Loops");
  for (const line of formatMaintenanceLoopDetailLines(loops)) {
    console.log(line);
  }
}

function formatEngine(report: HealthReport | null): string {
  if (report === null) return "skipped";
  if (report.status === "ok") return "ok";
  return `${report.summary.findingCount} finding(s) | ${report.summary.errorCount} error | ${report.summary.warningCount} warning`;
}

function formatProjection(report: CheckProjectionReport): string {
  if (!report.stale) return "fresh";
  return report.cache_drift ? "stale (cache drift)" : "stale";
}

function formatContent(report: CheckContentReport | null): string {
  if (report === null) return "skipped";
  const attention =
    report.diagnostics === 0
      ? ""
      : ` | ${report.attention_diagnostics} attention`;
  const unlocated =
    report.unlocated_diagnostics === 0
      ? ""
      : ` | ${report.unlocated_diagnostics} unlocated`;
  const filter =
    report.filter.attention
      ? formatAttentionFilter(report)
      : "";
  return `${report.diagnostics} diagnostic(s)${attention}${unlocated}${filter}`;
}

function formatAttentionFilter(report: CheckContentReport): string {
  if (report.filtered_diagnostics === 0) {
    return " | 0 attention shown";
  }
  if (report.items.length >= report.filtered_diagnostics) {
    return ` | showing ${report.filtered_diagnostics} attention`;
  }
  return ` | showing ${report.items.length} of ${report.filtered_diagnostics} attention`;
}

function formatDecisions(report: CheckDecisionReport | null): string {
  if (report === null) return "skipped";
  const agentReady = report.agent_safe_questions + report.model_safe_questions;
  if (report.questions === 0) return "0 open question(s)";
  return `${report.questions} open question(s) | ${agentReady} agent/model-safe | ${report.owner_needed_questions} owner-needed`;
}

function formatLoops(
  loops: ReadonlyArray<MaintenanceLoopSummary> | null,
): string {
  if (loops === null) return "unavailable";
  return formatMaintenanceLoopSummaryLine(loops);
}

function printFindings(findings: ReadonlyArray<HealthFinding>): void {
  if (findings.length === 0) return;
  console.log("");
  console.log("Engine");
  for (const finding of findings) {
    console.log(
      `  - [${finding.severity}] ${finding.code}: ${finding.message}`,
    );
    console.log(`    recovery: ${finding.recovery}`);
  }
}

function printDiagnostics(report: CheckContentReport | null): void {
  const items = report?.items ?? [];
  if (items.length === 0) return;
  printDiagnosticDispositionGroups(report);
  printDiagnosticRepairGroups(report);
  printDiagnosticMessageGroups(report);
  console.log("");
  console.log("Content");
  for (const item of items) {
    console.log(`  - [${item.severity}] ${item.code}: ${item.message}`);
    console.log(`    repair: ${item.repair_path} - ${item.repair_hint}`);
    console.log(
      `    disposition: ${item.disposition} - ${item.disposition_hint}`,
    );
    console.log(`    ${item.source_refs}`);
  }
  appendMoreLine(
    report?.filtered_diagnostics ?? 0,
    items.length,
    "diagnostics",
  );
}

function printDiagnosticDispositionGroups(
  report: CheckContentReport | null,
): void {
  if (report === null) return;
  const groups = report.disposition_summary.groups;
  if (!groups.some((group) => group.count > 1) && groups.length <= 1) return;
  console.log("");
  console.log("Content dispositions");
  for (const group of groups) {
    console.log(
      `  - ${group.disposition} x${group.count}: ${group.disposition_hint}`,
    );
    console.log(`    first: ${group.first_source_refs}`);
  }
  appendMoreGroupsLine(
    report.disposition_summary.group_count,
    groups.length,
    "disposition groups",
  );
}

function printDiagnosticRepairGroups(report: CheckContentReport | null): void {
  if (report === null) return;
  const groups = report.repair_summary.groups;
  if (!groups.some((group) => group.count > 1) && groups.length <= 1) return;
  console.log("");
  console.log("Content repair paths");
  for (const group of groups) {
    console.log(
      `  - ${group.repair_path} x${group.count}: ${group.repair_hint}`,
    );
    console.log(`    first: ${group.first_source_refs}`);
  }
  appendMoreGroupsLine(
    report.repair_summary.group_count,
    groups.length,
    "repair groups",
  );
}

function printDiagnosticMessageGroups(report: CheckContentReport | null): void {
  if (report === null) return;
  const groups = report.message_summary.groups;
  if (!groups.some((group) => group.count > 1)) return;
  console.log("");
  console.log("Content groups");
  for (const group of groups) {
    console.log(
      `  - [${group.severity}] ${group.code} x${group.count}: ${group.message}`,
    );
    console.log(`    first: ${group.first_source_refs}`);
  }
  appendMoreGroupsLine(
    report.message_summary.group_count,
    groups.length,
    "groups",
  );
}

function printQuestions(report: CheckDecisionReport | null): void {
  const items = report?.items ?? [];
  if (items.length === 0) return;
  console.log("");
  console.log("Decisions");
  for (const item of items) {
    const options = item.options === null ? "" : ` options: ${item.options.join(", ")}`;
    console.log(`  - #${item.id}: ${item.question}${options}`);
    console.log(`    policy: ${questionAutomationLabel(item.metadata)}`);
    if (item.recommended_answer !== null) {
      console.log(`    recommended: ${item.recommended_answer}`);
    }
    if (item.owner_needed_reason !== null) {
      console.log(`    owner-needed: ${item.owner_needed_reason}`);
    }
    console.log(`    ${item.source_refs}`);
    console.log(`    resolve: ${item.resolveCommand}`);
  }
  appendMoreLine(report?.questions ?? 0, items.length, "questions");
}

function appendMoreGroupsLine(total: number, shown: number, label: string): void {
  const remaining = total - shown;
  if (remaining <= 0) return;
  console.log(
    `  ... ${remaining} more ${label} (use --limit ${total} to show all ${label})`,
  );
}

function appendMoreLine(total: number, shown: number, label: string): void {
  const remaining = total - shown;
  if (remaining <= 0) return;
  console.log(
    `  ... ${remaining} more ${label} (use --limit ${total} to show all)`,
  );
}

function printNextActions(actions: ReadonlyArray<CliNextAction>): void {
  if (actions.length === 0) return;
  console.log("");
  console.log("Next");
  for (const action of actions) {
    console.log(`  - ${formatCliNextAction(action)}`);
  }
}

function parseLimit(raw: string | number | boolean | undefined): number | null {
  return parsePositiveIntegerValue(raw, DEFAULT_LIMIT);
}
