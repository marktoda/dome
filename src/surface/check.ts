// surface/check: the `dome.check/v1` report collector.
//
// `dome check` is the normal "see why Dome wants attention" surface. It
// consolidates the user-facing parts of doctor / lint / inspect questions
// without creating a new mutation path. Recovery still flows through
// QuestionEffect rows and `dome resolve`. This module collects the report
// document shared by `dome check --json` and the MCP `check` tool; terminal
// rendering lives in src/cli/commands/check.ts.

import { getAdoptedRef, getCurrentBranch } from "../adopted-ref";
import type { SourceRef } from "../core/source-ref";
import { commitOid } from "../core/source-ref";
import type { QuestionMetadata } from "../core/effect";
import {
  collectHealthReport,
  collectOperationalSchemaReport,
  type HealthReport,
} from "../engine/host/health";
import { openVaultRuntime, type VaultRuntime } from "../engine/host/vault-runtime";
import { resolveBundleRoots } from "../extensions/bundle-roots";
import { FIRST_PARTY_MAINTENANCE_LOOPS } from "../extensions/maintenance-loops";
import { queryRunSummaries } from "../ledger/runs";
import {
  projectionCacheKeysChanged,
  projectionRequiresRebuild,
} from "../projections/db";
import { queryDiagnostics } from "../projections/diagnostics";
import { queryQuestionRecords } from "../projections/questions";
import {
  countQuestionAutomationPolicies,
  questionAutomationPolicy,
  resolveQuestionCommand,
} from "../question-resolution";
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
} from "./diagnostic-summary";
import {
  collectMaintenanceLoopSummaries,
  type MaintenanceLoopSummary,
} from "./maintenance-loop-summary";
import {
  nextActionsForCheck,
  type CliNextAction,
} from "./next-actions";
import { resolveVaultPath } from "./resolve-vault";

const SCHEMA = "dome.check/v1";
export const DEFAULT_CHECK_LIMIT = 10;
const LOOP_RECENT_RUN_LIMIT = 25;

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

export type CheckScopes = {
  readonly engine: boolean;
  readonly content: boolean;
  readonly decisions: boolean;
};

export type CheckReport = {
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

export type CheckProjectionReport = {
  readonly stale: boolean;
  readonly cache_drift: boolean;
  readonly branch: string | null;
  readonly adopted: string | null;
};

export type CheckContentReport = {
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

export type CheckDiagnosticItem = {
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

export type CheckDecisionReport = {
  readonly questions: number;
  readonly agent_safe_questions: number;
  readonly model_safe_questions: number;
  readonly owner_needed_questions: number;
  readonly shownItems: number;
  readonly omittedItems: number;
  readonly items: ReadonlyArray<CheckQuestionItem>;
};

export type CheckQuestionItem = {
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

/** The data-returning outcome of one check-report collection. */
export type CheckReportOutcome =
  | { readonly kind: "ok"; readonly report: CheckReport }
  | { readonly kind: "runtime-open-failed"; readonly errorKind: string };

/**
 * Collect the full `dome.check/v1` report without printing. Opens and
 * closes its own runtime (or reports the operational-storage failure as a
 * degraded engine-scope report, matching the CLI). `runCheck` renders the
 * outcome for the terminal; the MCP `check` tool renders it as the same
 * JSON document.
 */
export async function buildCheckReport(opts: {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly scopes: CheckScopes;
  readonly attentionOnly: boolean;
  readonly limit: number;
  readonly orphanThresholdMs: number;
}): Promise<CheckReportOutcome> {
  const vaultPath = resolveVaultPath(opts.vault);
  const scopes = opts.scopes;
  const limit = opts.limit;
  const orphanThresholdMs = opts.orphanThresholdMs;

  const storageReport = collectOperationalSchemaReport({ vaultPath });
  if (storageReport.status === "unhealthy") {
    return Object.freeze({
      kind: "ok" as const,
      report: reportFromUnavailableRuntime({
        generatedAt: storageReport.generatedAt,
        scopes: Object.freeze({
          engine: true,
          content: false,
          decisions: false,
        }),
        engine: storageReport,
      }),
    });
  }

  const bundleRoots = resolveBundleRoots({
    vaultPath,
    bundlesRoot: opts.bundlesRoot,
  });
  const runtimeResult = await openVaultRuntime({ vaultPath, ...bundleRoots });
  if (!runtimeResult.ok) {
    return Object.freeze({
      kind: "runtime-open-failed" as const,
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
          attentionOnly: opts.attentionOnly,
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
    return Object.freeze({ kind: "ok" as const, report });
  } finally {
    await runtime.close();
  }
}

export function resolveScopes(options: RunCheckOptions): CheckScopes {
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
