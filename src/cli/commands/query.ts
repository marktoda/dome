// cli/commands/query: first-class adopted-state query command.
//
// `dome query` is a small typed wrapper around the command-triggered
// view-phase processor named `query`. The processor owns retrieval behavior;
// this file owns CLI ergonomics and rendering.

import { basename } from "node:path";

import {
  firstPartyViewNotFoundMessage,
  runStructuredViewCommand,
  structuredViewBrokerMessages,
} from "../../surface/view";
import { FIRST_PARTY_VIEWS } from "../../surface/view-catalog";
import {
  printViewCommandError,
  printViewCommandMessages,
} from "./view-shared";
import { formatJson } from "../../surface/format";
import { formatCommand } from "../human-output";
import {
  footer,
  glyph,
  headline,
  match as matchPrimitive,
  paint,
  resolveCaps,
  section,
  type Caps,
} from "../presenter";
import type { QuestionMetadata } from "../../core/effect";
import {
  questionAutomationLabel,
  questionAutomationPolicy,
  resolveQuestionCommand,
} from "../../question-resolution";

import { resolveVaultPath } from "../../surface/resolve-vault";
export type QueryCommandOptions = {
  readonly text?: string | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly category?: string | undefined;
  readonly type?: string | undefined;
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

  try {
    const run = await runStructuredViewCommand({
      commandLabel: "dome query",
      commandName: "query",
      expectedViewName: FIRST_PARTY_VIEWS.query.viewName,
      expectedSchema: FIRST_PARTY_VIEWS.query.schema,
      commandArgs: Object.freeze({
        text,
        ...(options.category !== undefined ? { category: options.category } : {}),
        ...(options.type !== undefined ? { type: options.type } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      }),
      vault: options.vault,
      bundlesRoot: options.bundlesRoot,
      notFoundMessage: firstPartyViewNotFoundMessage({
        commandLabel: "dome query",
        bundleId: FIRST_PARTY_VIEWS.query.bundleId,
        processorName: FIRST_PARTY_VIEWS.query.processorName,
      }),
      noStructuredResultMessage:
        "dome query: query processor returned no structured result.",
    });

    if (run.kind === "error") {
      printViewCommandError({
        commandLabel: "dome query",
        json: options.json === true,
        messages: run.messages,
      });
      return run.exitCode;
    }
    printViewCommandMessages(
      structuredViewBrokerMessages("dome query", run.brokerDiagnostics),
    );

    if (options.json === true) {
      console.log(formatJson(run.data));
    } else {
      console.log(formatQueryResult(run.data, resolveCaps(), vaultPath));
    }
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    printViewCommandError({
      commandLabel: "dome query",
      json: options.json === true,
      error: "query-failed",
      messages: [`dome query: failed: ${msg}`],
    });
    return 1;
  }
}

export function formatQueryResult(data: unknown, caps: Caps, vault?: string): string {
  const result = parseQueryResult(data);
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
    lines.push(...footer({ tone: "muted", label: "no matches" }, caps));
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
          `${indent}    ${paint("policy:", "muted", caps)} ${questionAutomationLabel(question.metadata)}`,
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

  lines.push(...footer({ tone: "ok", label: `${n} ${matchLabel}` }, caps));
  return lines.join("\n");
}

type QueryResultData = {
  readonly query: string;
  readonly limit: number | null;
  readonly shown: {
    readonly matches: number;
  };
  readonly hasMore: {
    readonly matches: boolean;
  };
  readonly matches: ReadonlyArray<{
    readonly path: string;
    readonly title: string;
    readonly breadcrumb: string | null;
    readonly snippet: string;
    readonly ranking: QueryRanking | null;
    readonly sourceRefs: ReadonlyArray<QuerySourceRef>;
    readonly facts: ReadonlyArray<{ readonly predicate: string }>;
    readonly diagnostics: ReadonlyArray<{ readonly code: string }>;
    readonly questions: ReadonlyArray<QueryQuestion>;
  }>;
};

type QueryRanking = {
  readonly score: number;
  readonly ftsRank: number;
  readonly reasons: ReadonlyArray<string>;
  readonly signals: ReadonlyArray<{
    readonly kind: string;
    readonly label: string;
    readonly weight: number;
    readonly count?: number;
  }>;
};

type QueryQuestion = {
  readonly id: number;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly resolveCommand: string;
  readonly metadata: QuestionMetadata | null;
  readonly automationPolicy: string;
  readonly sourceRefs: ReadonlyArray<QuerySourceRef>;
};

type QuerySourceRef = {
  readonly path: string;
  readonly commit: string;
  readonly range?: {
    readonly startLine: number;
    readonly endLine: number;
  };
};

function parseQueryResult(data: unknown): QueryResultData {
  if (!isObjectRecord(data)) {
    throw new Error("query structured data must be an object.");
  }
  const record = data;
  if (typeof record.query !== "string") {
    throw new Error("query structured data query must be a string.");
  }
  if (!isObjectRecord(record.shown)) {
    throw new Error("query structured data shown must be an object.");
  }
  if (!isObjectRecord(record.hasMore)) {
    throw new Error("query structured data hasMore must be an object.");
  }
  if (!Array.isArray(record.matches)) {
    throw new Error("query structured data matches must be an array.");
  }
  const query = record.query;
  const shownRecord = objectRecord(record.shown);
  const hasMoreRecord = objectRecord(record.hasMore);
  const rawMatches = record.matches;
  return Object.freeze({
    query,
    limit: numberValue(record.limit),
    shown: Object.freeze({
      matches: numberValue(shownRecord.matches) ?? rawMatches.length,
    }),
    hasMore: Object.freeze({
      matches: hasMoreRecord.matches === true,
    }),
    matches: Object.freeze(
      rawMatches.map((raw) => {
        const match = raw !== null && typeof raw === "object"
          ? raw as Record<string, unknown>
          : {};
        return Object.freeze({
          path: stringOrEmpty(match.path),
          title: stringOrEmpty(match.title),
          breadcrumb: typeof match.breadcrumb === "string" &&
              match.breadcrumb.length > 0
            ? match.breadcrumb
            : null,
          snippet: stringOrEmpty(match.snippet),
          ranking: parseRanking(match.ranking),
          sourceRefs: Object.freeze(parseSourceRefs(match.sourceRefs)),
          facts: Object.freeze(parseFacts(match.facts)),
          diagnostics: Object.freeze(parseDiagnostics(match.diagnostics)),
          questions: Object.freeze(parseQuestions(match.questions)),
        });
      }),
    ),
  });
}

function parseRanking(raw: unknown): QueryRanking | null {
  const record = objectRecord(raw);
  if (Object.keys(record).length === 0) return null;
  return Object.freeze({
    score: numberValue(record.score) ?? 0,
    ftsRank: numberValue(record.ftsRank) ?? 0,
    reasons: Object.freeze(parseStringArray(record.reasons)),
    signals: Object.freeze(parseRankingSignals(record.signals)),
  });
}

function parseRankingSignals(raw: unknown): QueryRanking["signals"] {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(
    raw
      .map((item) => {
        const record = objectRecord(item);
        const kind = stringOrEmpty(record.kind);
        const label = stringOrEmpty(record.label);
        const weight = numberValue(record.weight);
        if (kind.length === 0 || label.length === 0 || weight === null) {
          return null;
        }
        const count = numberValue(record.count);
        return Object.freeze({
          kind,
          label,
          weight,
          ...(count !== null ? { count } : {}),
        });
      })
      .filter((item): item is QueryRanking["signals"][number] =>
        item !== null
      ),
  );
}

function objectRecord(raw: unknown): Record<string, unknown> {
  return isObjectRecord(raw) ? raw : {};
}

function isObjectRecord(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

function parseFacts(raw: unknown): ReadonlyArray<{ readonly predicate: string }> {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(
    raw
      .map((item) => {
        const record = item !== null && typeof item === "object"
          ? item as Record<string, unknown>
          : {};
        const predicate = stringOrEmpty(record.predicate);
        return predicate.length > 0 ? { predicate } : null;
      })
      .filter((item): item is { readonly predicate: string } => item !== null),
  );
}

function parseDiagnostics(
  raw: unknown,
): ReadonlyArray<{ readonly code: string }> {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(
    raw
      .map((item) => {
        const record = item !== null && typeof item === "object"
          ? item as Record<string, unknown>
          : {};
        const code = stringOrEmpty(record.code);
        return code.length > 0 ? { code } : null;
      })
      .filter((item): item is { readonly code: string } => item !== null),
  );
}

function parseQuestions(
  raw: unknown,
): ReadonlyArray<QueryQuestion> {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(
    raw
      .map((item) => {
        const record = item !== null && typeof item === "object"
          ? item as Record<string, unknown>
          : {};
        const question = stringOrEmpty(record.question);
        if (question.length === 0) return null;
        const id = numberValue(record.id) ?? 0;
        const options = Object.freeze(parseStringArray(record.options));
        const metadata = parseQuestionMetadata(record.metadata);
        const resolveCommand = stringOrEmpty(record.resolveCommand) ||
          resolveQuestionCommand({ id, options });
        return Object.freeze({
          id,
          question,
          options,
          resolveCommand,
          metadata,
          automationPolicy: stringOrEmpty(record.automationPolicy) ||
            questionAutomationPolicy(metadata),
          sourceRefs: Object.freeze(parseSourceRefs(record.sourceRefs)),
        });
      })
      .filter((item): item is QueryQuestion => item !== null),
  );
}

function parseQuestionMetadata(raw: unknown): QuestionMetadata | null {
  const record = objectRecord(raw);
  if (Object.keys(record).length === 0) return null;
  const metadata: {
    -readonly [K in keyof QuestionMetadata]: QuestionMetadata[K];
  } = {};
  if (
    record.risk === "low" ||
    record.risk === "medium" ||
    record.risk === "high"
  ) {
    metadata.risk = record.risk;
  }
  if (typeof record.confidence === "number" && Number.isFinite(record.confidence)) {
    metadata.confidence = record.confidence;
  }
  if (typeof record.recommendedAnswer === "string") {
    metadata.recommendedAnswer = record.recommendedAnswer;
  }
  if (
    record.automationPolicy === "agent-safe" ||
    record.automationPolicy === "model-safe" ||
    record.automationPolicy === "owner-needed"
  ) {
    metadata.automationPolicy = record.automationPolicy;
  }
  if (typeof record.ownerNeededReason === "string") {
    metadata.ownerNeededReason = record.ownerNeededReason;
  }
  return Object.keys(metadata).length === 0 ? null : Object.freeze(metadata);
}

function parseStringArray(raw: unknown): ReadonlyArray<string> {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(raw.filter((item): item is string =>
    typeof item === "string"
  ));
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseSourceRefs(raw: unknown): ReadonlyArray<QuerySourceRef> {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(
    raw
      .map((item) => {
        const record = item !== null && typeof item === "object"
          ? item as Record<string, unknown>
          : {};
        const path = stringOrEmpty(record.path);
        const commit = stringOrEmpty(record.commit);
        if (path.length === 0 || commit.length === 0) return null;

        const range = parseRange(record.range);
        return Object.freeze({
          path,
          commit,
          ...(range !== null ? { range } : {}),
        });
      })
      .filter((item): item is QuerySourceRef => item !== null),
  );
}

function parseRange(raw: unknown): QuerySourceRef["range"] | null {
  const record = raw !== null && typeof raw === "object"
    ? raw as Record<string, unknown>
    : {};
  const startLine = numberValue(record.startLine);
  const endLine = numberValue(record.endLine);
  return startLine === null || endLine === null
    ? null
    : Object.freeze({ startLine, endLine });
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : null;
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
