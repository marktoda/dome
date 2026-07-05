// cli/commands/query: first-class adopted-state query command.
//
// `dome query` is a small typed wrapper around the command-triggered
// view-phase processor named `query`. The processor owns retrieval behavior;
// this file owns CLI ergonomics and rendering.

import { basename } from "node:path";

import { FIRST_PARTY_VIEWS } from "../../surface/view-catalog";
import {
  type QueryResultData,
  type QuerySourceRef,
} from "../../surface/query-view";
import { printMissOutcome, printViewCommandError } from "./view-shared";
import { runCliStructuredView } from "../structured-view-command";
import { formatCommand } from "../human-output";
import {
  glyph,
  headline,
  match as matchPrimitive,
  paint,
  resolveCaps,
  section,
  type Caps,
} from "../presenter";
import { questionAutomationLabel } from "../../question-resolution";
import type { QuestionMetadata } from "../../core/effect";

import { resolveVaultPath } from "../../surface/resolve-vault";
export type QueryCommandOptions = {
  readonly text?: string | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly category?: string | undefined;
  readonly type?: string | undefined;
  /** `--miss [note]`: Commander's optional-value shape — see `reportMissFromCliFlag`. */
  readonly miss?: string | boolean | undefined;
};

export async function runQuery(
  options: QueryCommandOptions = {},
): Promise<number> {
  const vaultPath = resolveVaultPath(options.vault);
  const text = options.text?.trim() ?? "";
  if (text.length === 0) {
    printViewCommandError({
      commandLabel: "dome query",
      json: options.json === true,
      error: "query-usage",
      messages: ["dome query: missing query text. Usage: dome query <text>"],
    });
    return 64;
  }

  const exitCode = await runCliStructuredView({
    commandLabel: "dome query",
    entry: FIRST_PARTY_VIEWS.query,
    commandArgs: Object.freeze({
      text,
      ...(options.category !== undefined ? { category: options.category } : {}),
      ...(options.type !== undefined ? { type: options.type } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    }),
    vault: options.vault,
    bundlesRoot: options.bundlesRoot,
    json: options.json === true,
    noStructuredResultMessage:
      "dome query: query processor returned no structured result.",
    failedError: "query-failed",
    renderHuman: (data) => formatQueryResult(data, resolveCaps(), vaultPath),
  });

  // After printing results: --miss records this query as a retrieval miss
  // (docs/wiki/specs/preferences.md-style append-only log at
  // meta/retrieval-misses.md). Side-channel message on stderr so stdout
  // stays the query's own output/JSON, unpolluted.
  await printMissOutcome({
    commandLabel: "dome query",
    vault: vaultPath,
    query: text,
    flag: options.miss,
  });

  return exitCode;
}

export function formatQueryResult(data: QueryResultData, caps: Caps, vault?: string): string {
  const result = data;
  const n = result.matches.length;
  const matchLabel = n === 1 ? "match" : "matches";
  const cmdLeft = vault !== undefined
    ? { cmd: "query", context: basename(vault) }
    : { cmd: "query" };

  if (n === 0) {
    const lines: string[] = [
      headline(
        cmdLeft,
        { tone: "muted", label: "no matches" },
        caps,
      ),
    ];
    const noMatchSummary = `"${result.query}" — 0 matches`;
    lines.push("", `  ${paint(noMatchSummary, "muted", caps)}`);
    return lines.join("\n");
  }

  const lines: string[] = [
    headline(
      cmdLeft,
      { tone: "ok", label: `${n} ${matchLabel}` },
      caps,
    ),
  ];

  // Compact summary line — no QUERY kv block in human output.
  // No total-count field exists on the result, so we only say "showing N"
  // when hasMore is true (the caller can raise --limit to see more).
  const summary = result.hasMore.matches
    ? `"${result.query}" — showing ${result.shown.matches}, raise with --limit`
    : `"${result.query}" — ${n} ${matchLabel}`;
  lines.push("", `  ${paint(summary, "muted", caps)}`);

  const matchLines = result.matches.flatMap((m, i) => {
    const titlePrefix = `${m.title} › `;
    const crumb = m.breadcrumb !== null && m.breadcrumb.startsWith(titlePrefix)
      ? m.breadcrumb.slice(titlePrefix.length)
      : m.breadcrumb;
    const crumbVal = crumb !== null && crumb !== m.title && crumb.length > 0
      ? crumb
      : undefined;
    const snippetVal = m.snippet.length > 0 ? stripFtsMarkers(m.snippet) : undefined;
    const sourceRefVal = m.sourceRefs.length > 0
      ? formatSourceRef(m.sourceRefs[0]!)
      : undefined;
    const rendered = matchPrimitive(
      {
        rank: i + 1,
        title: m.title,
        path: m.path,
        ...(crumbVal !== undefined ? { breadcrumb: crumbVal } : {}),
        ...(snippetVal !== undefined ? { snippet: snippetVal } : {}),
        ...(sourceRefVal !== undefined ? { sourceRef: sourceRefVal } : {}),
      },
      caps,
    );
    // questions remain in human output (they are actionable, not telemetry)
    const questionLines: string[] = [];
    if (m.questions.length > 0) {
      const indent = " ".repeat(7); // aligns under title for rank 1–9
      questionLines.push(`${indent}${paint("questions:", "muted", caps)}`);
      for (const question of m.questions.slice(0, 5)) {
        const refs =
          question.sourceRefs.length === 0
            ? ""
            : ` (${question.sourceRefs.map(formatSourceRef).join(", ")})`;
        questionLines.push(
          `${indent}  ${glyph("bullet", caps)} [#${question.id}] ${question.question}${refs}`,
        );
        questionLines.push(
          `${indent}    ${paint("policy:", "muted", caps)} ${questionAutomationLabel(question.metadata as QuestionMetadata | null)}`,
        );
        questionLines.push(
          `${indent}    ${paint("resolve:", "muted", caps)} ${formatCommand(question.resolveCommand)}`,
        );
      }
    }
    return [...rendered, ...questionLines, ""];
  });
  // Drop trailing blank line
  if (matchLines[matchLines.length - 1] === "") matchLines.pop();
  lines.push(...section("Matches", matchLines, caps));

  return lines.join("\n");
}

function formatSourceRef(ref: QuerySourceRef): string {
  const range = ref.range === undefined
    ? ""
    : `:${ref.range.startLine}-${ref.range.endLine}`;
  return `${ref.path}${range} @ ${ref.commit.slice(0, 7)}`;
}

function stripFtsMarkers(snippet: string): string {
  return snippet.replace(/\[/g, "").replace(/\]/g, "");
}
