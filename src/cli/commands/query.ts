// cli/commands/query: first-class adopted-state query command.
//
// `dome query` is a small typed wrapper around the command-triggered
// view-phase processor named `query`. The processor owns retrieval behavior;
// this file owns CLI ergonomics and rendering.

import { basename } from "node:path";

import {
  firstPartyViewNotFoundMessage,
  printViewCommandError,
  printViewCommandMessages,
  runStructuredViewCommand,
  structuredViewBrokerMessages,
} from "./view-shared";
import { formatJson } from "../format";
import { formatCommand } from "../human-output";
import {
  footer,
  glyph,
  headline,
  kv,
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

import { resolveVaultPath } from "../resolve-vault";
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
      expectedViewName: "dome.search.query",
      expectedSchema: "dome.search.query/v1",
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
        bundleId: "dome.search",
        processorName: "query",
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

function formatQueryResult(data: unknown, caps: Caps, vault?: string): string {
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
    lines.push(
      ...section(
        "Query",
        kv([{ label: "text", value: `"${result.query}"`, tone: "plain" }], caps),
        caps,
      ),
    );
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

  lines.push(
    ...section(
      "Query",
      kv(
        [
          { label: "text", value: `"${result.query}"`, tone: "plain" },
          {
            label: "shown",
            value: `${result.shown.matches} ${result.shown.matches === 1 ? "match" : "matches"}`,
          },
          {
            label: "limit",
            value: result.limit === null ? "default" : String(result.limit),
          },
          { label: "has more", value: result.hasMore.matches ? "yes" : "no" },
        ],
        caps,
      ),
      caps,
    ),
  );

  const matchLines: string[] = [];
  for (const [index, match] of result.matches.entries()) {
    matchLines.push(`${index + 1}. ${paint(match.title, "plain", caps)}`);
    matchLines.push(`   ${paint("path:", "muted", caps)} ${match.path}`);
    if (match.breadcrumb !== null && match.breadcrumb !== match.title) {
      matchLines.push(
        `   ${paint("section:", "muted", caps)} ${match.breadcrumb}`,
      );
    }
    if (match.snippet.length > 0) {
      matchLines.push(
        `   ${paint("text:", "muted", caps)} ${stripFtsMarkers(match.snippet)}`,
      );
    }
    if (match.ranking !== null && match.ranking.reasons.length > 0) {
      const why =
        `${match.ranking.reasons.join("; ")} ` +
        `(score ${match.ranking.score}, fts ${match.ranking.ftsRank})`;
      matchLines.push(`   ${paint("why:", "muted", caps)} ${why}`);
    }
    if (match.sourceRefs.length > 0) {
      matchLines.push(
        `   ${paint("source:", "muted", caps)} ${match.sourceRefs.map(formatSourceRef).join(", ")}`,
      );
    }
    if (match.facts.length > 0) {
      const facts = summarizeLabels(
        match.facts.map((fact) => fact.predicate),
        5,
      );
      matchLines.push(`   ${paint("facts:", "muted", caps)} ${facts}`);
    }
    if (match.diagnostics.length > 0) {
      const diagnostics = summarizeLabels(
        match.diagnostics.map((diagnostic) => diagnostic.code),
        5,
      );
      matchLines.push(
        `   ${paint("diagnostics:", "muted", caps)} ${diagnostics}`,
      );
    }
    if (match.questions.length > 0) {
      matchLines.push(`   ${paint("questions:", "muted", caps)}`);
      for (const question of match.questions.slice(0, 5)) {
        const refs =
          question.sourceRefs.length === 0
            ? ""
            : ` (${question.sourceRefs.map(formatSourceRef).join(", ")})`;
        matchLines.push(
          `     ${glyph("bullet", caps)} [#${question.id}] ${question.question}${refs}`,
        );
        matchLines.push(
          `       ${paint("policy:", "muted", caps)} ${questionAutomationLabel(question.metadata)}`,
        );
        matchLines.push(
          `       ${paint("resolve:", "muted", caps)} ${formatCommand(question.resolveCommand)}`,
        );
      }
    }
    if (index < result.matches.length - 1) matchLines.push("");
  }
  lines.push(...section("Matches", matchLines, caps));

  if (result.hasMore.matches) {
    lines.push("");
    lines.push(
      paint(
        "(more adopted-state matches exist; increase --limit to show more)",
        "muted",
        caps,
      ),
    );
  }

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

function summarizeLabels(
  labels: ReadonlyArray<string>,
  limit: number,
): string {
  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const rendered = [...counts.entries()]
    .slice(0, limit)
    .map(([label, count]) => count === 1 ? label : `${label} x${count}`);
  const omitted = counts.size - rendered.length;
  if (omitted > 0) rendered.push(`+${omitted} more`);
  return rendered.join(", ");
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
