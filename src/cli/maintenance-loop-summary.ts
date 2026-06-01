// CLI-facing maintenance-loop summaries.
//
// This module deliberately summarizes loop metadata from existing durable
// processor state. It does not dispatch loops or add a new execution path.

import type { DiagnosticEffect } from "../core/effect";
import type { MaintenanceLoop } from "../extensions/maintenance-loops";
import { isActiveProblemRun, type RunRow } from "../ledger/runs";
import type { QuestionRecord } from "../projections/questions";
import {
  countAttentionDiagnostics,
  isSourceBackedDiagnostic,
} from "./diagnostic-summary";

export type MaintenanceLoopState =
  | "inactive"
  | "partial"
  | "attention"
  | "quiet";

export type MaintenanceLoopSummary = {
  readonly id: string;
  readonly goal: string;
  readonly state: MaintenanceLoopState;
  readonly processor_ids: ReadonlyArray<string>;
  readonly active_processors: ReadonlyArray<string>;
  readonly missing_processors: ReadonlyArray<string>;
  readonly surfaces: ReadonlyArray<string>;
  readonly settlement: {
    readonly key: string;
    readonly no_op_when: string;
  };
  readonly diagnostics: number;
  readonly attention_diagnostics: number;
  readonly questions: number;
  readonly recent_runs: number;
  readonly recent_problem_runs: number;
  readonly latest_run_at: string | null;
};

export function collectMaintenanceLoopSummaries(opts: {
  readonly loops: ReadonlyArray<MaintenanceLoop>;
  readonly activeProcessorIds: ReadonlySet<string>;
  readonly diagnosticsByProcessor: (processorId: string) => ReadonlyArray<DiagnosticEffect>;
  readonly unresolvedQuestions: ReadonlyArray<QuestionRecord>;
  readonly runsByProcessor: (processorId: string) => ReadonlyArray<RunRow>;
}): ReadonlyArray<MaintenanceLoopSummary> {
  return Object.freeze(opts.loops.map((loop) => summarizeLoop(loop, opts)));
}

function summarizeLoop(
  loop: MaintenanceLoop,
  opts: {
    readonly activeProcessorIds: ReadonlySet<string>;
    readonly diagnosticsByProcessor: (processorId: string) => ReadonlyArray<DiagnosticEffect>;
    readonly unresolvedQuestions: ReadonlyArray<QuestionRecord>;
    readonly runsByProcessor: (processorId: string) => ReadonlyArray<RunRow>;
  },
): MaintenanceLoopSummary {
  const activeProcessors = loop.processors.filter((id) =>
    opts.activeProcessorIds.has(id)
  );
  const missingProcessors = loop.processors.filter((id) =>
    !opts.activeProcessorIds.has(id)
  );

  let diagnostics = 0;
  let attentionDiagnostics = 0;
  let recentRuns = 0;
  let recentProblemRuns = 0;
  let latestRunAt: string | null = null;
  for (const processorId of loop.processors) {
    const processorDiagnostics = opts.diagnosticsByProcessor(processorId);
    diagnostics += processorDiagnostics.length;
    attentionDiagnostics += countAttentionDiagnostics(
      processorDiagnostics.filter(isSourceBackedDiagnostic),
    );

    const runs = opts.runsByProcessor(processorId);
    recentRuns += runs.length;
    recentProblemRuns += runs.filter(isActiveProblemRun).length;
    for (const run of runs) {
      if (latestRunAt === null || run.startedAt > latestRunAt) {
        latestRunAt = run.startedAt;
      }
    }
  }

  const processorSet = new Set(loop.processors);
  const questions = opts.unresolvedQuestions.filter((question) =>
    processorSet.has(question.processorId)
  ).length;

  return Object.freeze({
    id: loop.id,
    goal: loop.goal,
    state: stateForLoop({
      activeProcessors: activeProcessors.length,
      missingProcessors: missingProcessors.length,
      attentionDiagnostics,
      questions,
      recentProblemRuns,
    }),
    processor_ids: Object.freeze([...loop.processors]),
    active_processors: Object.freeze(activeProcessors),
    missing_processors: Object.freeze(missingProcessors),
    surfaces: Object.freeze(loop.surfaces.map(formatSurface)),
    settlement: Object.freeze({
      key: loop.settlement.key,
      no_op_when: loop.settlement.noOpWhen,
    }),
    diagnostics,
    attention_diagnostics: attentionDiagnostics,
    questions,
    recent_runs: recentRuns,
    recent_problem_runs: recentProblemRuns,
    latest_run_at: latestRunAt,
  });
}

function stateForLoop(input: {
  readonly activeProcessors: number;
  readonly missingProcessors: number;
  readonly attentionDiagnostics: number;
  readonly questions: number;
  readonly recentProblemRuns: number;
}): MaintenanceLoopState {
  if (
    input.attentionDiagnostics > 0 ||
    input.questions > 0 ||
    input.recentProblemRuns > 0
  ) {
    return "attention";
  }
  if (input.activeProcessors === 0) return "inactive";
  if (input.missingProcessors > 0) return "partial";
  return "quiet";
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
