// cli/commands/check: `dome check` — terminal rendering for the unified
// read-only attention report. The report collector (`buildCheckReport`) and
// the `dome.check/v1` document types live in src/surface/check.ts, shared
// with the MCP `check` tool; this module owns option parsing and rendering.

import { basename } from "node:path";

import {
  DEFAULT_ORPHAN_RUN_THRESHOLD_MS,
  type HealthReport,
} from "../../engine/host/health";
import { findingLines } from "./health-finding-view";
import { emitRuntimeOpenFailure } from "../command-error";
import {
  buildCheckReport,
  DEFAULT_CHECK_LIMIT,
  resolveScopes,
  type CheckContentReport,
  type CheckDecisionReport,
  type CheckDiagnosticItem,
  type CheckProjectionReport,
  type CheckReport,
  type RunCheckOptions,
} from "../../surface/check";
import { questionAutomationLabel } from "../../question-resolution";
import { formatJson } from "../../surface/format";
import {
  formatCommand,
  formatSeverity,
  plural,
  truncateText,
} from "../human-output";
import {
  bullets,
  headline,
  humanizeCommand,
  kv,
  nextActions,
  resolveCaps,
  section,
  statusValue,
  type Caps,
  type KvRow,
  type Status,
} from "../presenter";
import type { MaintenanceLoopSummary } from "../../surface/maintenance-loop-summary";
import {
  formatMaintenanceLoopDetailLines,
  formatMaintenanceLoopSummaryLine,
} from "../maintenance-loop-summary";
import {
  parseNonNegativeIntegerValue,
  parsePositiveIntegerValue,
} from "../parse-options";
import { resolveVaultPath } from "../../surface/resolve-vault";
import { EX_USAGE } from "../exit-codes";

export type { RunCheckOptions } from "../../surface/check";

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

  const outcome = await buildCheckReport({
    vault: options.vault,
    bundlesRoot: options.bundlesRoot,
    scopes: resolveScopes(options),
    attentionOnly: contentAttentionOnlyForRender(options),
    limit,
    orphanThresholdMs,
  });
  if (outcome.kind === "runtime-open-failed") {
    return emitRuntimeOpenFailure({
      command: "check",
      json: options.json === true,
      errorKind: outcome.errorKind,
    });
  }

  printReport(outcome.report, options.json === true, {
    showLoopDetails: options.loops === true,
    verbose: options.verbose === true,
    vaultPath: resolveVaultPath(options.vault),
  });
  return 0;
}

function contentAttentionOnlyForRender(options: RunCheckOptions): boolean {
  if (options.attention === true) return true;
  if (options.json === true) return false;
  return options.content !== true;
}

function printReport(
  report: CheckReport,
  json: boolean,
  options: { readonly showLoopDetails: boolean; readonly verbose: boolean; readonly vaultPath: string },
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
  options: { readonly showLoopDetails: boolean; readonly verbose: boolean; readonly vaultPath: string; readonly caps: Caps },
): ReadonlyArray<string> {
  const caps = options.caps;
  const glance = (label: string, st: Status): KvRow => ({
    label,
    value: statusValue(st, caps),
    tone: "plain",
  });

  // Verdict header: problems = error+warning, notes = info
  const verdictStatus = checkVerdictStatus(report);
  const lines: string[] = [
    headline({ cmd: "check", context: basename(options.vaultPath) }, verdictStatus, caps),
  ];

  if (!options.verbose) {
    // Default: headerless — action line(s) directly, then finding rows directly.
    // Matches dome status default: blank line → nextActions → blank line → rows.
    // No NEXT/ENGINE/CONTENT/DECISIONS section labels.
    const actionLines = oneLineNextActions(report.next_actions, caps);
    if (actionLines.length > 0) {
      lines.push("");
      lines.push(...actionLines);
    }
    const engineFindingLines = findingLines(report.engine?.findings ?? [], caps, false);
    if (engineFindingLines.length > 0) {
      lines.push("");
      lines.push(...engineFindingLines);
    }
    const contentLines = diagnosticLines(report.content, caps);
    if (contentLines.length > 0) {
      lines.push("");
      lines.push(...contentLines);
    }
    const decisionLines = questionLines(report.decisions, caps);
    if (decisionLines.length > 0) {
      lines.push("");
      lines.push(...decisionLines);
    }
    if (options.showLoopDetails) {
      const loopLines = loopDetailLines(report.maintenance_loops, caps);
      if (loopLines.length > 0) {
        lines.push(...section("Loops", loopLines, caps));
      }
    }
    return Object.freeze(lines);
  }

  // Verbose: NEXT section then AT A GLANCE
  lines.push(...section("Next", oneLineNextActions(report.next_actions, caps), caps));

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
              value: formatLoops(report.maintenance_loops, caps),
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

  // Engine findings: terse by default, verbose=true adds "why" lines
  lines.push(...section("Engine", findingLines(report.engine?.findings ?? [], caps, options.verbose), caps));
  lines.push(...section("Content", diagnosticLines(report.content, caps), caps));
  lines.push(...section("Decisions", questionLines(report.decisions, caps), caps));

  // No footer in either default or verbose mode.

  return Object.freeze(lines);
}

/**
 * Verdict header status: counts engine findings as problems (error+warning)
 * and notes (info). When there are no findings and status is ok, "all clear".
 * Stale projection treated as a problem.
 */
function checkVerdictStatus(report: CheckReport): Status {
  const summary = report.engine?.summary;
  const problems = (summary?.errorCount ?? 0) + (summary?.warningCount ?? 0);
  const notes = summary?.infoCount ?? 0;

  if (problems === 0 && notes === 0 && report.status === "ok" && !report.projection.stale) {
    return { tone: "ok", label: "all clear" };
  }

  const parts: string[] = [];
  if (problems > 0) {
    parts.push(`${problems} ${problems === 1 ? "problem" : "problems"}`);
  }
  if (notes > 0) {
    parts.push(`${notes} ${notes === 1 ? "note" : "notes"}`);
  }
  if (parts.length === 0) {
    // status=attention but no engine findings (e.g. content/decisions attention)
    return { tone: "warn", label: "needs attention" };
  }
  return { tone: "warn", label: parts.join(" · ") };
}

/**
 * Render next_actions as a single humanized line per action:
 * - command has ` --json` stripped via `humanizeCommand`
 * - description collapsed to the first clause (before "; ") to avoid run-on
 *   multi-sentence paragraphs in the terminal summary
 */
function oneLineNextActions(
  actions: ReadonlyArray<{ readonly command: string | null; readonly description: string }>,
  caps: Caps,
): ReadonlyArray<string> {
  return nextActions(
    actions.map((a) => ({
      command: a.command !== null ? humanizeCommand(a.command) : null,
      description: firstClause(a.description),
    })),
    caps,
  );
}

/** Take text up to the first "; " separator, stripping a trailing period. */
function firstClause(text: string): string {
  const idx = text.indexOf("; ");
  const clause = idx === -1 ? text : text.slice(0, idx);
  return clause.replace(/\.$/, "");
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
  const { errorCount, warningCount, infoCount } = report.summary;
  return {
    tone: "warn",
    label: `${errorCount} error · ${warningCount} warning · ${infoCount} info`,
  };
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
  return `${plural(report.questions, "open question")} · ${agentReady} agent-safe · ${report.owner_needed_questions} owner-needed`;
}

function formatLoops(
  loops: ReadonlyArray<MaintenanceLoopSummary> | null,
  caps: Caps,
): string {
  if (loops === null) return "unavailable";
  return formatMaintenanceLoopSummaryLine(loops, caps);
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
  return parsePositiveIntegerValue(raw, DEFAULT_CHECK_LIMIT);
}
