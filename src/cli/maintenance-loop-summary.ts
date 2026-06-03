// CLI-facing maintenance-loop summaries.
//
// This module deliberately summarizes loop metadata from existing durable
// processor state. It does not dispatch loops or add a new execution path.

import type { DiagnosticEffect } from "../core/effect";
import type { MaintenanceLoop } from "../extensions/maintenance-loops";
import { isActiveProblemRun, type RunSummaryRow } from "../ledger/runs";
import type { QuestionRecord } from "../projections/questions";
import { countQuestionAutomationPolicies } from "../question-resolution";
import {
  countAttentionDiagnostics,
  diagnosticDisposition,
  isSourceBackedDiagnostic,
} from "./diagnostic-summary";
import { tree, type Caps } from "./presenter";

export type MaintenanceLoopState =
  | "inactive"
  | "partial"
  | "attention"
  | "drift"
  | "quiet";

export type MaintenanceLoopSummary = {
  readonly id: string;
  readonly goal: string;
  readonly state: MaintenanceLoopState;
  readonly question_scope: "processors" | "all";
  readonly processor_ids: ReadonlyArray<string>;
  readonly required_processor_ids: ReadonlyArray<string>;
  readonly optional_processor_ids: ReadonlyArray<string>;
  readonly active_processors: ReadonlyArray<string>;
  readonly missing_processors: ReadonlyArray<string>;
  readonly inactive_optional_processors: ReadonlyArray<string>;
  readonly surfaces: ReadonlyArray<string>;
  readonly settlement: {
    readonly key: string;
    readonly no_op_when: string;
    readonly settled: boolean;
    readonly checks: ReadonlyArray<MaintenanceLoopSettlementCheckSummary>;
    readonly failed_checks: ReadonlyArray<string>;
  };
  readonly diagnostics: number;
  readonly attention_diagnostics: number;
  readonly drift_diagnostics: number;
  readonly noise_diagnostics: number;
  readonly questions: number;
  readonly agent_safe_questions: number;
  readonly model_safe_questions: number;
  readonly owner_needed_questions: number;
  readonly recent_runs: number;
  readonly recent_problem_runs: number;
  readonly latest_run_at: string | null;
  readonly last_successful_run_at: string | null;
  readonly latest_problem_run_at: string | null;
};

export type MaintenanceLoopSettlementCheckSummary = {
  readonly name: string;
  readonly kind: MaintenanceLoop["settlement"]["checks"][number]["kind"];
  readonly status: "pass" | "fail";
  readonly observed: number;
  readonly expected: string;
  readonly description: string;
};

export function collectMaintenanceLoopSummaries(opts: {
  readonly loops: ReadonlyArray<MaintenanceLoop>;
  readonly activeProcessorIds: ReadonlySet<string>;
  readonly diagnosticsByProcessor: (processorId: string) => ReadonlyArray<DiagnosticEffect>;
  readonly unresolvedQuestions: ReadonlyArray<QuestionRecord>;
  readonly runsByProcessor: (processorId: string) => ReadonlyArray<RunSummaryRow>;
}): ReadonlyArray<MaintenanceLoopSummary> {
  return Object.freeze(opts.loops.map((loop) => summarizeLoop(loop, opts)));
}

export function formatMaintenanceLoopSummaryLine(
  loops: ReadonlyArray<MaintenanceLoopSummary>,
): string {
  const counts = {
    quiet: 0,
    attention: 0,
    drift: 0,
    partial: 0,
    inactive: 0,
  };
  for (const loop of loops) {
    counts[loop.state] += 1;
  }
  return `${loops.length} known · ${counts.quiet} quiet · ${counts.attention} attention · ${counts.drift} drift · ${counts.partial} partial · ${counts.inactive} inactive`;
}

export function formatMaintenanceLoopDetailLines(
  loops: ReadonlyArray<MaintenanceLoopSummary>,
  caps: Caps,
): ReadonlyArray<string> {
  const nodes = loops.map((loop) => ({
    label: `[${loop.state}] ${loop.id}: ${loop.goal}`,
    lines: buildLoopDetailLines(loop),
  }));
  return tree(nodes, caps);
}

function buildLoopDetailLines(loop: MaintenanceLoopSummary): ReadonlyArray<string> {
  const lines: string[] = [];

  // Processors: active/total + missing if any
  lines.push(`processors: ${loop.active_processors.length}/${loop.processor_ids.length} active`);
  if (loop.missing_processors.length > 0) {
    lines.push(`missing: ${formatBoundedList(loop.missing_processors)}`);
  }

  // Attention: only non-zero terms
  const attentionParts: string[] = [];
  if (loop.attention_diagnostics > 0) attentionParts.push(`${loop.attention_diagnostics} attention`);
  if (loop.drift_diagnostics > 0) attentionParts.push(`${loop.drift_diagnostics} drift`);
  if (loop.noise_diagnostics > 0) attentionParts.push(`${loop.noise_diagnostics} noise`);
  if (loop.questions > 0) attentionParts.push(`${loop.questions} question(s)`);
  if (loop.recent_problem_runs > 0) attentionParts.push(`${loop.recent_problem_runs} problem run(s)`);
  if (attentionParts.length > 0) {
    lines.push(`attention: ${attentionParts.join(", ")}`);
  }

  // Questions breakdown only when there are questions
  if (loop.questions > 0) {
    const qParts: string[] = [];
    if (loop.agent_safe_questions > 0) qParts.push(`${loop.agent_safe_questions} agent-safe`);
    if (loop.model_safe_questions > 0) qParts.push(`${loop.model_safe_questions} model-safe`);
    if (loop.owner_needed_questions > 0) qParts.push(`${loop.owner_needed_questions} owner-needed`);
    if (qParts.length > 0) lines.push(`questions: ${qParts.join(", ")}`);
  }

  // Surfaces
  if (loop.surfaces.length > 0) {
    lines.push(`surfaces: ${loop.surfaces.join(", ")}`);
  }

  // Settlement
  const passedChecks = countPassedSettlementChecks(loop.settlement.checks);
  const settlementStatus = loop.settlement.settled ? "settled" : "unsettled";
  lines.push(`settlement: ${settlementStatus} (${passedChecks}/${loop.settlement.checks.length})`);
  if (loop.settlement.failed_checks.length > 0) {
    lines.push(`failed: ${formatBoundedList(loop.settlement.failed_checks)}`);
  }

  // No-op condition
  lines.push(`no-op: ${loop.settlement.no_op_when}`);

  // Run timestamps — omit null/none rows
  if (loop.latest_run_at !== null) {
    lines.push(`latest run: ${loop.latest_run_at}`);
  }
  if (loop.last_successful_run_at !== null) {
    lines.push(`last success: ${loop.last_successful_run_at}`);
  }
  if (loop.latest_problem_run_at !== null) {
    lines.push(`latest problem: ${loop.latest_problem_run_at}`);
  }

  return Object.freeze(lines);
}

function summarizeLoop(
  loop: MaintenanceLoop,
  opts: {
    readonly activeProcessorIds: ReadonlySet<string>;
    readonly diagnosticsByProcessor: (processorId: string) => ReadonlyArray<DiagnosticEffect>;
    readonly unresolvedQuestions: ReadonlyArray<QuestionRecord>;
    readonly runsByProcessor: (processorId: string) => ReadonlyArray<RunSummaryRow>;
  },
): MaintenanceLoopSummary {
  const optionalProcessors = loop.optionalProcessors ?? Object.freeze([]);
  const processorIds = Object.freeze([
    ...loop.processors,
    ...optionalProcessors,
  ]);
  const activeProcessors = processorIds.filter((id) =>
    opts.activeProcessorIds.has(id)
  );
  const missingProcessors = loop.processors.filter((id) =>
    !opts.activeProcessorIds.has(id)
  );
  const inactiveOptionalProcessors = optionalProcessors.filter((id) =>
    !opts.activeProcessorIds.has(id)
  );
  const activeRequiredProcessors = loop.processors.filter((id) =>
    opts.activeProcessorIds.has(id)
  );

  let diagnostics = 0;
  let attentionDiagnostics = 0;
  let noiseDiagnostics = 0;
  let recentRuns = 0;
  let recentProblemRuns = 0;
  let latestRunAt: string | null = null;
  let lastSuccessfulRunAt: string | null = null;
  let latestProblemRunAt: string | null = null;
  for (const processorId of processorIds) {
    const processorDiagnostics = opts.diagnosticsByProcessor(processorId);
    const sourceBackedDiagnostics = processorDiagnostics.filter(
      isSourceBackedDiagnostic,
    );
    diagnostics += processorDiagnostics.length;
    attentionDiagnostics += countAttentionDiagnostics(
      sourceBackedDiagnostics,
    );
    noiseDiagnostics += sourceBackedDiagnostics.filter((diagnostic) =>
      diagnosticDisposition(diagnostic).disposition === "noise"
    ).length;

    const runs = opts.runsByProcessor(processorId);
    recentRuns += runs.length;
    const latestProblemRun = latestActiveProblemRun(runs);
    if (latestProblemRun !== null) {
      recentProblemRuns += 1;
      if (
        latestProblemRunAt === null ||
        latestProblemRun.startedAt > latestProblemRunAt
      ) {
        latestProblemRunAt = latestProblemRun.startedAt;
      }
    }
    for (const run of runs) {
      if (latestRunAt === null || run.startedAt > latestRunAt) {
        latestRunAt = run.startedAt;
      }
      if (
        run.status === "succeeded" &&
        (lastSuccessfulRunAt === null || run.startedAt > lastSuccessfulRunAt)
      ) {
        lastSuccessfulRunAt = run.startedAt;
      }
    }
  }

  const questionScope = loop.questionScope ?? "processors";
  const processorSet = new Set(processorIds);
  const loopQuestions = questionsForLoop({
    questions: opts.unresolvedQuestions,
    processorSet,
    questionScope,
  });
  const questionPolicyCounts = countQuestionAutomationPolicies(
    loopQuestions.map((question) => question.effect.metadata),
  );
  const driftDiagnostics = Math.max(
    0,
    diagnostics - attentionDiagnostics - noiseDiagnostics,
  );
  const settlementChecks = evaluateSettlementChecks({
    checks: loop.settlement.checks,
    requiredProcessorCount: loop.processors.length,
    activeRequiredProcessors: activeRequiredProcessors.length,
    missingProcessors: missingProcessors.length,
    attentionDiagnostics,
    driftDiagnostics,
    questions: loopQuestions.length,
    recentProblemRuns,
  });
  const failedSettlementChecks = settlementChecks
    .filter((check) => check.status === "fail")
    .map((check) => check.name);

  return Object.freeze({
    id: loop.id,
    goal: loop.goal,
    state: stateForLoop({
      activeRequiredProcessors: activeRequiredProcessors.length,
      missingProcessors: missingProcessors.length,
      attentionDiagnostics,
      questions: loopQuestions.length,
      recentProblemRuns,
      driftDiagnostics,
    }),
    question_scope: questionScope,
    processor_ids: processorIds,
    required_processor_ids: Object.freeze([...loop.processors]),
    optional_processor_ids: Object.freeze([...optionalProcessors]),
    active_processors: Object.freeze(activeProcessors),
    missing_processors: Object.freeze(missingProcessors),
    inactive_optional_processors: Object.freeze(inactiveOptionalProcessors),
    surfaces: Object.freeze(loop.surfaces.map(formatSurface)),
    settlement: Object.freeze({
      key: loop.settlement.key,
      no_op_when: loop.settlement.noOpWhen,
      settled: failedSettlementChecks.length === 0,
      checks: Object.freeze(settlementChecks),
      failed_checks: Object.freeze(failedSettlementChecks),
    }),
    diagnostics,
    attention_diagnostics: attentionDiagnostics,
    questions: loopQuestions.length,
    drift_diagnostics: driftDiagnostics,
    noise_diagnostics: noiseDiagnostics,
    agent_safe_questions: questionPolicyCounts.agentSafe,
    model_safe_questions: questionPolicyCounts.modelSafe,
    owner_needed_questions: questionPolicyCounts.ownerNeeded,
    recent_runs: recentRuns,
    recent_problem_runs: recentProblemRuns,
    latest_run_at: latestRunAt,
    last_successful_run_at: lastSuccessfulRunAt,
    latest_problem_run_at: latestProblemRunAt,
  });
}

function evaluateSettlementChecks(input: {
  readonly checks: MaintenanceLoop["settlement"]["checks"];
  readonly requiredProcessorCount: number;
  readonly activeRequiredProcessors: number;
  readonly missingProcessors: number;
  readonly attentionDiagnostics: number;
  readonly driftDiagnostics: number;
  readonly questions: number;
  readonly recentProblemRuns: number;
}): ReadonlyArray<MaintenanceLoopSettlementCheckSummary> {
  return Object.freeze(
    input.checks.map((check) => {
      switch (check.kind) {
        case "required-processors-active":
          return settlementCheckSummary(check, {
            status: input.missingProcessors === 0 ? "pass" : "fail",
            observed: input.activeRequiredProcessors,
            expected: `${input.requiredProcessorCount} active required processor(s)`,
          });
        case "no-attention-diagnostics":
          return settlementCheckSummary(check, {
            status: input.attentionDiagnostics === 0 ? "pass" : "fail",
            observed: input.attentionDiagnostics,
            expected: "0 attention diagnostic(s)",
          });
        case "no-drift-diagnostics":
          return settlementCheckSummary(check, {
            status: input.driftDiagnostics === 0 ? "pass" : "fail",
            observed: input.driftDiagnostics,
            expected: "0 drift diagnostic(s)",
          });
        case "no-open-questions":
          return settlementCheckSummary(check, {
            status: input.questions === 0 ? "pass" : "fail",
            observed: input.questions,
            expected: "0 open question(s)",
          });
        case "no-recent-problem-runs":
          return settlementCheckSummary(check, {
            status: input.recentProblemRuns === 0 ? "pass" : "fail",
            observed: input.recentProblemRuns,
            expected: "0 recent problem run(s)",
          });
      }
      const _exhaustive: never = check.kind;
      return _exhaustive;
    }),
  );
}

function settlementCheckSummary(
  check: MaintenanceLoop["settlement"]["checks"][number],
  result: Pick<
    MaintenanceLoopSettlementCheckSummary,
    "status" | "observed" | "expected"
  >,
): MaintenanceLoopSettlementCheckSummary {
  return Object.freeze({
    name: check.name,
    kind: check.kind,
    status: result.status,
    observed: result.observed,
    expected: result.expected,
    description: check.description,
  });
}

function countPassedSettlementChecks(
  checks: ReadonlyArray<MaintenanceLoopSettlementCheckSummary>,
): number {
  return checks.filter((check) => check.status === "pass").length;
}

function questionsForLoop(input: {
  readonly questions: ReadonlyArray<QuestionRecord>;
  readonly processorSet: ReadonlySet<string>;
  readonly questionScope: "processors" | "all";
}): ReadonlyArray<QuestionRecord> {
  if (input.questionScope === "all") return input.questions;
  return input.questions.filter((question) =>
    input.processorSet.has(question.processorId)
  );
}

function stateForLoop(input: {
  readonly activeRequiredProcessors: number;
  readonly missingProcessors: number;
  readonly attentionDiagnostics: number;
  readonly questions: number;
  readonly recentProblemRuns: number;
  readonly driftDiagnostics: number;
}): MaintenanceLoopState {
  if (
    input.attentionDiagnostics > 0 ||
    input.questions > 0 ||
    input.recentProblemRuns > 0
  ) {
    return "attention";
  }
  if (input.activeRequiredProcessors === 0) return "inactive";
  if (input.missingProcessors > 0) return "partial";
  if (input.driftDiagnostics > 0) return "drift";
  return "quiet";
}

function latestActiveProblemRun(
  runs: ReadonlyArray<RunSummaryRow>,
): RunSummaryRow | null {
  let latest: RunSummaryRow | null = null;
  for (const run of runs) {
    if (latest === null || run.startedAt > latest.startedAt) {
      latest = run;
    }
  }
  return latest !== null && isActiveProblemRun(latest) ? latest : null;
}

function formatSurface(surface: MaintenanceLoop["surfaces"][number]): string {
  switch (surface.kind) {
    case "path":
      return `path:${surface.pattern}`;
    case "command":
      return `command:${surface.name}`;
    case "projection":
      return `projection:${surface.name}`;
    case "status":
      return `status:${surface.name}`;
  }
  const _exhaustive: never = surface;
  return _exhaustive;
}

function formatBoundedList(values: ReadonlyArray<string>): string {
  const maxShown = 3;
  const shown = values.slice(0, maxShown);
  const remaining = values.length - shown.length;
  if (remaining <= 0) return shown.join(", ");
  return `${shown.join(", ")}, +${remaining} more`;
}
