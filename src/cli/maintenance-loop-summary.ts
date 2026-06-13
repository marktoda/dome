// cli/maintenance-loop-summary: terminal rendering for loop summaries.
//
// The data side (`collectMaintenanceLoopSummaries` and the summary types)
// lives in src/surface/maintenance-loop-summary.ts; this module owns the
// human-mode summary line and detail tree only.

import { dimZeros, tree, type Caps } from "./presenter";
import type {
  MaintenanceLoopSettlementCheckSummary,
  MaintenanceLoopSummary,
} from "../surface/maintenance-loop-summary";

export function formatMaintenanceLoopSummaryLine(
  loops: ReadonlyArray<MaintenanceLoopSummary>,
  caps: Caps,
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
  return dimZeros(
    [
      `${loops.length} known`,
      `${counts.quiet} quiet`,
      `${counts.attention} attention`,
      `${counts.drift} drift`,
      `${counts.partial} partial`,
      `${counts.inactive} inactive`,
    ],
    caps,
  );
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

function countPassedSettlementChecks(
  checks: ReadonlyArray<MaintenanceLoopSettlementCheckSummary>,
): number {
  return checks.filter((check) => check.status === "pass").length;
}

function formatBoundedList(values: ReadonlyArray<string>): string {
  const maxShown = 3;
  const shown = values.slice(0, maxShown);
  const remaining = values.length - shown.length;
  if (remaining <= 0) return shown.join(", ");
  return `${shown.join(", ")}, +${remaining} more`;
}
