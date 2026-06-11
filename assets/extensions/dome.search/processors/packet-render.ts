// dome.search/packet-render: markdown rendering for the export-context packet — presentation only, no scoring or selection logic.

import {
  questionAutomationLabel,
} from "../../../../src/question-resolution";
import type { SourceRef } from "../../../../src/core/source-ref";
import type {
  ContextEntry,
  ContextOverview,
} from "./export-context";

export const MAX_RELATED_ROWS = 8;
export const SCHEMA = "dome.search.export-context/v1";

export function renderMarkdown(
  topic: string,
  overview: ContextOverview,
  entries: ReadonlyArray<ContextEntry>,
  hasMoreEntries: boolean,
): string {
  const lines = [
    `# Dome Context: ${topic}`,
    "",
    `Schema: \`${SCHEMA}\``,
    "",
  ];

  if (entries.length === 0) {
    lines.push("No adopted-state matches.");
    return lines.join("\n");
  }

  renderOverview(lines, overview);

  lines.push("## Matches");
  for (const [index, entry] of entries.entries()) {
    lines.push("");
    lines.push(`### ${index + 1}. ${entry.title}`);
    lines.push(`- Path: \`${entry.path}\``);
    if (entry.breadcrumb !== null && entry.breadcrumb !== entry.title) {
      lines.push(`- Section: ${entry.breadcrumb}`);
    }
    lines.push(`- Category: \`${entry.category}\``);
    if (entry.type !== null) lines.push(`- Type: \`${entry.type}\``);
    if (entry.ranking.reasons.length > 0) {
      lines.push(
        `- Ranking: ${entry.ranking.reasons.join("; ")} ` +
          `(score ${entry.ranking.score}, fts ${entry.ranking.ftsRank})`,
      );
    }
    lines.push("- SourceRefs:");
    for (const ref of entry.sourceRefs) {
      lines.push(`  - \`${formatSourceRef(ref)}\``);
    }
    if (entry.summary.length > 0) {
      lines.push("");
      lines.push("Summary:");
      for (const item of entry.summary) {
        const refs = item.sourceRefs.map(formatSourceRef).join(", ");
        lines.push(`- \`${item.kind}\`: ${item.text} (${refs})`);
      }
    }
    if (entry.snippet.length > 0) {
      lines.push("");
      lines.push("> " + entry.snippet.replace(/\n/g, "\n> "));
    }
    if (entry.facts.length > 0) {
      lines.push("");
      lines.push("Facts:");
      const facts = entry.facts.slice(0, MAX_RELATED_ROWS);
      for (const fact of facts) {
        const refs = fact.sourceRefs.map(formatSourceRef).join(", ");
        lines.push(`- \`${fact.predicate}\`: ${fact.object} (${refs})`);
      }
      appendMoreLine(lines, entry.factCount, facts.length, "facts");
    }
    if (entry.diagnostics.length > 0) {
      lines.push("");
      lines.push("Diagnostics:");
      const diagnostics = entry.diagnostics.slice(0, MAX_RELATED_ROWS);
      for (const diagnostic of diagnostics) {
        const refs = diagnostic.sourceRefs.map(formatSourceRef).join(", ");
        lines.push(
          `- \`${diagnostic.severity}\` \`${diagnostic.code}\`: ${diagnostic.message} (${refs})`,
        );
      }
      appendMoreLine(
        lines,
        entry.diagnosticCount,
        diagnostics.length,
        "diagnostics",
      );
    }
    if (entry.questions.length > 0) {
      lines.push("");
      lines.push("Questions:");
      const questions = entry.questions.slice(0, MAX_RELATED_ROWS);
      for (const question of questions) {
        const refs = question.sourceRefs.map(formatSourceRef).join(", ");
        lines.push(`- [#${question.id}] ${question.question} (${refs})`);
        lines.push(`  policy: ${questionAutomationLabel(question.metadata)}`);
        lines.push(`  resolve: ${question.resolveCommand}`);
      }
      appendMoreLine(
        lines,
        entry.questionCount,
        questions.length,
        "questions",
      );
    }
  }

  if (hasMoreEntries) {
    lines.push("");
    lines.push(
      "- ... more adopted-state matches exist (increase --limit to include more entries)",
    );
  }

  return lines.join("\n");
}

function renderOverview(lines: string[], overview: ContextOverview): void {
  if (overview.readFirst.length > 0) {
    lines.push("## Read First");
    for (const [index, item] of overview.readFirst.entries()) {
      lines.push(
        `${index + 1}. \`${item.path}\` - ${item.title} (${item.reason})`,
      );
    }
    lines.push("");
  }

  if (overview.openLoops.length > 0) {
    lines.push("## Open Loops");
    for (const item of overview.openLoops) {
      const refs = item.sourceRefs.map(formatSourceRef).join(", ");
      lines.push(
        `- \`${item.path}\` \`${item.predicate}\`: ${item.text} (${refs})`,
      );
    }
    lines.push("");
  }

  if (overview.decisions.length > 0) {
    lines.push("## Decisions");
    for (const item of overview.decisions) {
      const refs = item.sourceRefs.map(formatSourceRef).join(", ");
      lines.push(
        `- \`${item.path}\` \`${item.predicate}\`: ${item.text} (${refs})`,
      );
    }
    lines.push("");
  }

  if (overview.unresolvedQuestions.length > 0) {
    lines.push("## Unresolved Questions");
    for (const question of overview.unresolvedQuestions) {
      const refs = question.sourceRefs.map(formatSourceRef).join(", ");
      lines.push(
        `- [#${question.id}] \`${question.path}\`: ${question.question} (${refs})`,
      );
      lines.push(`  policy: ${questionAutomationLabel(question.metadata)}`);
      lines.push(`  resolve: ${question.resolveCommand}`);
    }
    lines.push("");
  }

  if (overview.diagnostics.length > 0) {
    lines.push("## Active Diagnostics");
    for (const diagnostic of overview.diagnostics) {
      const refs = diagnostic.sourceRefs.map(formatSourceRef).join(", ");
      lines.push(
        `- \`${diagnostic.path}\` \`${diagnostic.severity}\` \`${diagnostic.code}\`: ${diagnostic.message} (${refs})`,
      );
    }
    lines.push("");
  }

  if (overview.recallSignals.length > 0) {
    lines.push("## Recall Signals");
    for (const signal of overview.recallSignals) {
      const refs = signal.sourceRefs.map(formatSourceRef).join(", ");
      lines.push(
        `- \`${signal.path}\` ${signal.label}: ${signal.text} (${refs})`,
      );
    }
    lines.push("");
  }
}

function appendMoreLine(
  lines: string[],
  total: number,
  shown: number,
  label: string,
): void {
  const remaining = total - shown;
  if (remaining <= 0) return;
  lines.push(`- ... ${remaining} more ${label}`);
}

function formatSourceRef(ref: SourceRef): string {
  const suffix = ref.range === undefined
    ? ""
    : `:${ref.range.startLine}-${ref.range.endLine}`;
  return `${ref.path}${suffix} @ ${ref.commit.slice(0, 7)}`;
}
