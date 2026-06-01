// cli/commands/check: unified read-only attention report.
//
// `dome check` is the normal "see why Dome wants attention" surface. It
// consolidates the user-facing parts of doctor / lint / inspect questions
// without creating a new mutation path. Recovery still flows through
// QuestionEffect rows and `dome resolve`.

import { resolve } from "node:path";

import type { SourceRef } from "../../core/source-ref";
import {
  collectHealthReport,
  collectOperationalSchemaReport,
  DEFAULT_ORPHAN_RUN_THRESHOLD_MS,
  type HealthFinding,
  type HealthReport,
} from "../../engine/health";
import { openVaultRuntime } from "../../engine/vault-runtime";
import { queryDiagnostics } from "../../projections/diagnostics";
import { queryQuestionRecords } from "../../projections/questions";
import { resolveQuestionCommand } from "../../question-resolution";
import {
  countAttentionDiagnostics,
  formatSourceRefs,
  RECOVERY_SOURCE_REF_FORMAT,
  sortDiagnosticsByMessagePriority,
  summarizeDiagnosticEffects,
  summarizeDiagnosticMessages,
  type DiagnosticMessageSummary,
  type DiagnosticSummary,
} from "../diagnostic-summary";
import { formatJson } from "../format";
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
  readonly engine: HealthReport | null;
  readonly content: CheckContentReport | null;
  readonly decisions: CheckDecisionReport | null;
  readonly next_actions: ReadonlyArray<CliNextAction>;
};

type CheckContentReport = {
  readonly diagnostics: number;
  readonly attention_diagnostics: number;
  readonly filtered_diagnostics: number;
  readonly filter: {
    readonly attention: boolean;
  };
  readonly summary: DiagnosticSummary;
  readonly message_summary: DiagnosticMessageSummary;
  readonly items: ReadonlyArray<CheckDiagnosticItem>;
};

type CheckDiagnosticItem = {
  readonly severity: string;
  readonly code: string;
  readonly message: string;
  readonly source_refs: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type CheckDecisionReport = {
  readonly questions: number;
  readonly items: ReadonlyArray<CheckQuestionItem>;
};

type CheckQuestionItem = {
  readonly id: number;
  readonly question: string;
  readonly options: ReadonlyArray<string> | null;
  readonly resolveCommand: string;
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
    printReport(report, options.json === true);
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
          diagnostics: queryDiagnostics(runtime.projectionDb),
          attentionOnly: options.attention === true,
          limit,
        })
      : null;
    const decisions = scopes.decisions
      ? collectDecisionReport({
          questions: queryQuestionRecords(runtime.projectionDb, {
            resolved: false,
          }),
          limit,
        })
      : null;
    const report = buildReport({
      generatedAt: engine?.generatedAt ?? new Date().toISOString(),
      scopes,
      engine,
      content,
      decisions,
    });
    printReport(report, options.json === true);
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

function collectContentReport(opts: {
  readonly diagnostics: ReturnType<typeof queryDiagnostics>;
  readonly attentionOnly: boolean;
  readonly limit: number;
}): CheckContentReport {
  const filteredDiagnostics = opts.attentionOnly
    ? opts.diagnostics.filter((diagnostic) => diagnostic.severity !== "info")
    : opts.diagnostics;
  const repairOrderedDiagnostics =
    sortDiagnosticsByMessagePriority(filteredDiagnostics);
  return Object.freeze({
    diagnostics: opts.diagnostics.length,
    attention_diagnostics: countAttentionDiagnostics(opts.diagnostics),
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
    items: Object.freeze(
      repairOrderedDiagnostics.slice(0, opts.limit).map((diagnostic) =>
        Object.freeze({
          severity: diagnostic.severity,
          code: diagnostic.code,
          message: diagnostic.message,
          source_refs: formatSourceRefs(
            diagnostic.sourceRefs,
            RECOVERY_SOURCE_REF_FORMAT,
          ),
          sourceRefs: diagnostic.sourceRefs,
        })
      ),
    ),
  });
}

function collectDecisionReport(opts: {
  readonly questions: ReturnType<typeof queryQuestionRecords>;
  readonly limit: number;
}): CheckDecisionReport {
  return Object.freeze({
    questions: opts.questions.length,
    items: Object.freeze(
      opts.questions.slice(0, opts.limit).map((question) => {
        const options = question.effect.options ?? null;
        return Object.freeze({
          id: question.id,
          question: question.effect.question,
          options,
          resolveCommand: resolveQuestionCommand({
            id: question.id,
            options,
          }),
          processor_id: question.processorId,
          source_refs: formatSourceRefs(
            question.effect.sourceRefs,
            RECOVERY_SOURCE_REF_FORMAT,
          ),
          sourceRefs: question.effect.sourceRefs,
        });
      }),
    ),
  });
}

function buildReport(input: {
  readonly generatedAt: string;
  readonly scopes: CheckScopes;
  readonly engine: HealthReport | null;
  readonly content: CheckContentReport | null;
  readonly decisions: CheckDecisionReport | null;
}): CheckReport {
  const engineFindings = input.engine?.summary.findingCount ?? 0;
  const attentionDiagnostics = input.content?.attention_diagnostics ?? 0;
  const questions = input.decisions?.questions ?? 0;
  return Object.freeze({
    schema: SCHEMA,
    status: engineFindings > 0 || attentionDiagnostics > 0 || questions > 0
      ? "attention"
      : "ok",
    generatedAt: input.generatedAt,
    scopes: input.scopes,
    engine: input.engine,
    content: input.content,
    decisions: input.decisions,
    next_actions: nextActionsForCheck({
      engineFindings,
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
    engine: input.engine,
    content: null,
    decisions: null,
  });
}

function printReport(report: CheckReport, json: boolean): void {
  if (json) {
    console.log(formatJson(report));
    return;
  }
  console.log("DOME check");
  console.log(`status    ${report.status}`);
  console.log(`engine    ${formatEngine(report.engine)}`);
  console.log(`content   ${formatContent(report.content)}`);
  console.log(`decisions ${formatDecisions(report.decisions)}`);
  printFindings(report.engine?.findings ?? []);
  printDiagnostics(report.content);
  printQuestions(report.decisions);
  printNextActions(report.next_actions);
}

function formatEngine(report: HealthReport | null): string {
  if (report === null) return "skipped";
  if (report.status === "ok") return "ok";
  return `${report.summary.findingCount} finding(s) | ${report.summary.errorCount} error | ${report.summary.warningCount} warning`;
}

function formatContent(report: CheckContentReport | null): string {
  if (report === null) return "skipped";
  const attention =
    report.diagnostics === 0
      ? ""
      : ` | ${report.attention_diagnostics} attention`;
  const filter =
    report.filter.attention
      ? formatAttentionFilter(report)
      : "";
  return `${report.diagnostics} diagnostic(s)${attention}${filter}`;
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
  return `${report.questions} open question(s)`;
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
  printDiagnosticMessageGroups(report);
  console.log("");
  console.log("Content");
  for (const item of items) {
    console.log(`  - [${item.severity}] ${item.code}: ${item.message}`);
    console.log(`    ${item.source_refs}`);
  }
  appendMoreLine(
    report?.filtered_diagnostics ?? 0,
    items.length,
    "diagnostics",
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
