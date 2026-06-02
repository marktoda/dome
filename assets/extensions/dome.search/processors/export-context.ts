// dome.search.export-context — portable, source-backed context packets.

import {
  viewEffect,
  type DiagnosticEffect,
  type Effect,
  type FactEffect,
  type QuestionMetadata,
  type ViewEffect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
  type ProjectionQueryView,
  type SearchDocumentResult,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";
import {
  questionAutomationLabel,
  questionAutomationPolicy,
} from "../../../../src/question-resolution";
import {
  groupByMatchingPath,
  questionItemFromProjection,
  uniqueSourceRefs,
  type SearchQuestionItem,
} from "./related";
import {
  compareRankedSearchEntries,
  expandedSearchLimit,
  isSearchDecisionFact,
  isSearchOpenLoopFact,
  rankSearchCandidate,
  SEARCH_DECISION_PREDICATES,
  SEARCH_OPEN_LOOP_PREDICATES,
  type SearchRanking,
  type SearchRankingRecallSignal,
} from "./ranking";

const SCHEMA = "dome.search.export-context/v1";
const DEFAULT_LIMIT = 8;
const MAX_RELATED_ROWS = 8;
const MAX_RECALL_PATHS = 24;
const TASK_METADATA_MARKER =
  /(?:^|\s)(?:\u{1F4C5}\s*\d{4}-\d{2}-\d{2}|\u{1F53A}|\u{23EB}|\u{1F53C}|\u{1F53D}|\u{23EC})(?=\s|$)/gu;
const TASK_DUE_MARKER =
  /(?:^|\s)\u{1F4C5}\s*(\d{4}-\d{2}-\d{2})(?=\s|$)/u;

const exportContext: Processor = defineProcessor({
  id: "dome.search.export-context",
  version: "0.1.8",
  phase: "view",
  triggers: [{ kind: "command", name: "export-context" }],
  capabilities: [{ kind: "read", paths: ["**/*.md"] }],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (ctx.projection === undefined) {
      throw new Error(
        "dome.search.export-context: ctx.projection is undefined; view-phase processors require a ProjectionQueryView",
      );
    }

    const projection = ctx.projection;
    const input = parseInput(ctx.input);
    const searchMatches = projection.searchDocuments({
      query: input.topic,
      limit: expandedSearchLimit(input.limit),
    });
    const allDiagnostics = projection.diagnostics();
    const allQuestions = projection
      .questions({ resolved: false })
      .map(questionItemFromProjection);
    const recallSignalsByPath = recallSignalsForTopic({
      projection,
      topic: input.topic,
      diagnostics: allDiagnostics,
      questions: allQuestions,
    });
    const searchMatchPaths = new Set(searchMatches.map((match) => match.path));
    const recalledPaths = prioritizedRecallPaths(
      recallSignalsByPath,
      searchMatchPaths,
    ).slice(0, MAX_RECALL_PATHS);
    const recalledMatches = projection.documentsByPath(recalledPaths);
    const candidateMatches = Object.freeze([
      ...searchMatches,
      ...recalledMatches,
    ]);
    const matchPaths = new Set(candidateMatches.map((match) => match.path));
    const factsByPath = new Map(
      candidateMatches.map((match) => [
        match.path,
        projection.facts({
          subjectKind: "page",
          subjectId: match.path,
        }),
      ]),
    );
    const diagnosticsByPath = groupByMatchingPath(
      allDiagnostics,
      matchPaths,
    );
    const questionsByPath = groupByMatchingPath(
      allQuestions,
      matchPaths,
    );
    const rankedMatches = Object.freeze(
      candidateMatches
        .map((match) =>
          Object.freeze({
            ...match,
            ranking: rankSearchCandidate({
              match,
              facts: factsByPath.get(match.path) ?? Object.freeze([]),
              diagnostics: diagnosticsByPath.get(match.path) ??
                Object.freeze([]),
              questions: questionsByPath.get(match.path) ?? Object.freeze([]),
              recallSignals: recallSignalsByPath.get(match.path) ??
                Object.freeze([]),
            }),
            facts: factsByPath.get(match.path) ?? Object.freeze([]),
            diagnostics: diagnosticsByPath.get(match.path) ?? Object.freeze([]),
            questions: questionsByPath.get(match.path) ?? Object.freeze([]),
          })
        )
        .sort(compareRankedSearchEntries),
    );
    const matches = Object.freeze(rankedMatches.slice(0, input.limit));
    const hasMoreEntries = rankedMatches.length > matches.length;
    const entries = matches.map((match) =>
      contextEntryFromMatch(
        match,
        match.facts,
        match.diagnostics,
        match.questions,
        match.ranking,
      ),
    );
    const overview = buildOverview(input.topic, entries, recallSignalsByPath);
    const scope = uniqueSourceRefs(
      entries.flatMap((entry) => [
        ...entry.sourceRefs,
        ...entry.facts.flatMap((fact) => fact.sourceRefs),
        ...entry.diagnostics.flatMap((diagnostic) => diagnostic.sourceRefs),
        ...entry.questions.flatMap((question) => question.sourceRefs),
      ]),
    );
    const data = Object.freeze({
      schema: SCHEMA,
      topic: input.topic,
      limit: input.limit,
      shown: Object.freeze({
        entries: entries.length,
      }),
      hasMore: Object.freeze({
        entries: hasMoreEntries,
      }),
      overview,
      markdown: renderMarkdown(input.topic, overview, entries, hasMoreEntries),
      entries: Object.freeze(entries),
    });

    const effect: ViewEffect = viewEffect({
      name: "dome.search.export-context",
      content: {
        kind: "structured",
        schema: SCHEMA,
        data,
      },
      scope,
    });
    return [effect];
  },
});

export default exportContext;

type ExportInput = {
  readonly topic: string;
  readonly limit: number;
};

type ContextEntry = {
  readonly path: string;
  readonly title: string;
  readonly category: string;
  readonly type: string | null;
  readonly snippet: string;
  readonly rank: number;
  readonly ranking: SearchRanking;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
  readonly facts: ReadonlyArray<ContextFact>;
  readonly diagnostics: ReadonlyArray<ContextDiagnostic>;
  readonly questions: ReadonlyArray<ContextQuestion>;
};

type ContextOverview = {
  readonly readFirst: ReadonlyArray<ContextReadFirst>;
  readonly openLoops: ReadonlyArray<ContextOpenLoop>;
  readonly decisions: ReadonlyArray<ContextDecision>;
  readonly unresolvedQuestions: ReadonlyArray<ContextQuestionSummary>;
  readonly diagnostics: ReadonlyArray<ContextDiagnosticSummary>;
  readonly recallSignals: ReadonlyArray<ContextRecallSignalSummary>;
};

type ContextReadFirst = {
  readonly path: string;
  readonly title: string;
  readonly reason: string;
  readonly rank: number;
  readonly ranking: SearchRanking;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type ContextFact = {
  readonly predicate: string;
  readonly object: string;
  readonly assertion: FactEffect["assertion"];
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type ContextOpenLoop = {
  readonly path: string;
  readonly predicate: string;
  readonly text: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type ContextDecision = {
  readonly path: string;
  readonly predicate: string;
  readonly text: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type ContextDiagnostic = {
  readonly severity: DiagnosticEffect["severity"];
  readonly code: string;
  readonly message: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type ContextDiagnosticSummary = ContextDiagnostic & {
  readonly path: string;
};

type ContextRecallSignal = SearchRankingRecallSignal & {
  readonly path: string;
  readonly kind: "open-loop" | "decision" | "question" | "diagnostic";
  readonly text: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type ContextRecallSignalSummary = Omit<ContextRecallSignal, "weight" | "count">;

type ContextQuestion = {
  readonly id: number;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly resolveCommand: string;
  readonly metadata: QuestionMetadata | null;
  readonly automationPolicy: string;
  readonly processorId: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type ContextQuestionSummary = ContextQuestion & {
  readonly path: string;
};

function contextEntryFromMatch(
  match: SearchDocumentResult,
  facts: ReadonlyArray<FactEffect>,
  diagnostics: ReadonlyArray<DiagnosticEffect>,
  questions: ReadonlyArray<SearchQuestionItem>,
  ranking: SearchRanking,
): ContextEntry {
  return Object.freeze({
    path: match.path,
    title: match.title,
    category: match.category,
    type: match.type,
    snippet: stripFtsMarkers(match.snippet),
    rank: match.rank,
    ranking,
    sourceRefs: Object.freeze([...match.sourceRefs]),
    facts: Object.freeze(
      facts
        .map((fact) =>
          Object.freeze({
            predicate: fact.predicate,
            object: factObjectLabel(fact),
            assertion: fact.assertion,
            sourceRefs: Object.freeze([...fact.sourceRefs]),
          })
        )
        .sort(compareFacts),
    ),
    diagnostics: Object.freeze(
      diagnostics
        .map((diagnostic) =>
          Object.freeze({
            severity: diagnostic.severity,
            code: diagnostic.code,
            message: diagnostic.message,
            sourceRefs: Object.freeze([...diagnostic.sourceRefs]),
          })
        )
        .sort(compareDiagnostics),
    ),
    questions: Object.freeze(
      questions
        .map((question) =>
          Object.freeze({
            id: question.id,
            question: question.question,
            options: question.options,
            resolveCommand: question.resolveCommand,
            metadata: question.metadata ?? null,
            automationPolicy: questionAutomationPolicy(question.metadata),
            processorId: question.processorId,
            sourceRefs: Object.freeze([...question.sourceRefs]),
          })
        )
        .sort(compareQuestions),
    ),
  });
}

function buildOverview(
  topic: string,
  entries: ReadonlyArray<ContextEntry>,
  recallSignalsByPath: ReadonlyMap<string, ReadonlyArray<ContextRecallSignal>>,
): ContextOverview {
  return Object.freeze({
    readFirst: Object.freeze(
      entries.map((entry) =>
        Object.freeze({
          path: entry.path,
          title: entry.title,
          reason: readFirstReason(topic, entry),
          rank: entry.rank,
          ranking: entry.ranking,
          sourceRefs: entry.sourceRefs,
        })
      ),
    ),
    openLoops: Object.freeze(
      uniqueOpenLoops(entries).slice(0, MAX_RELATED_ROWS),
    ),
    decisions: Object.freeze(
      uniqueDecisions(entries).slice(0, MAX_RELATED_ROWS),
    ),
    unresolvedQuestions: Object.freeze(
      uniqueQuestions(entries).slice(0, MAX_RELATED_ROWS),
    ),
    diagnostics: Object.freeze(
      uniqueDiagnostics(entries).slice(0, MAX_RELATED_ROWS),
    ),
    recallSignals: Object.freeze(
      uniqueRecallSignals(entries, recallSignalsByPath).slice(0, MAX_RELATED_ROWS),
    ),
  });
}

function readFirstReason(topic: string, entry: ContextEntry): string {
  const parts = [
    `matches "${topic}"`,
    ...entry.ranking.reasons,
  ];
  return parts.join("; ");
}

function uniqueOpenLoops(
  entries: ReadonlyArray<ContextEntry>,
): ReadonlyArray<ContextOpenLoop> {
  const seen = new Set<string>();
  const out: ContextOpenLoop[] = [];
  for (const entry of entries) {
    for (const fact of entry.facts) {
      if (!isSearchOpenLoopFact(fact)) continue;
      const key = `${entry.path}\u0000${fact.predicate}\u0000${fact.object}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(Object.freeze({
        path: entry.path,
        predicate: fact.predicate,
        text: fact.object,
        sourceRefs: fact.sourceRefs,
      }));
    }
  }
  return Object.freeze(out);
}

function uniqueDecisions(
  entries: ReadonlyArray<ContextEntry>,
): ReadonlyArray<ContextDecision> {
  const seen = new Set<string>();
  const out: ContextDecision[] = [];
  for (const entry of entries) {
    for (const fact of entry.facts) {
      if (!isSearchDecisionFact(fact)) continue;
      const key = `${entry.path}\u0000${fact.predicate}\u0000${fact.object}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(Object.freeze({
        path: entry.path,
        predicate: fact.predicate,
        text: fact.object,
        sourceRefs: fact.sourceRefs,
      }));
    }
  }
  return Object.freeze(out);
}

function uniqueQuestions(
  entries: ReadonlyArray<ContextEntry>,
): ReadonlyArray<ContextQuestionSummary> {
  const seen = new Set<number>();
  const out: ContextQuestionSummary[] = [];
  for (const entry of entries) {
    for (const question of entry.questions) {
      if (seen.has(question.id)) continue;
      seen.add(question.id);
      out.push(Object.freeze({
        ...question,
        path: entry.path,
      }));
    }
  }
  return Object.freeze(out);
}

function uniqueDiagnostics(
  entries: ReadonlyArray<ContextEntry>,
): ReadonlyArray<ContextDiagnosticSummary> {
  const seen = new Set<string>();
  const out: ContextDiagnosticSummary[] = [];
  for (const entry of entries) {
    for (const diagnostic of entry.diagnostics) {
      const key = [
        entry.path,
        diagnostic.severity,
        diagnostic.code,
        diagnostic.message,
      ].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(Object.freeze({
        ...diagnostic,
        path: entry.path,
      }));
    }
  }
  return Object.freeze(out);
}

function uniqueRecallSignals(
  entries: ReadonlyArray<ContextEntry>,
  recallSignalsByPath: ReadonlyMap<string, ReadonlyArray<ContextRecallSignal>>,
): ReadonlyArray<ContextRecallSignalSummary> {
  const seen = new Set<string>();
  const out: ContextRecallSignalSummary[] = [];
  for (const entry of entries) {
    for (const signal of recallSignalsByPath.get(entry.path) ?? []) {
      const key = [
        signal.path,
        signal.kind,
        signal.text,
      ].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(Object.freeze({
        path: signal.path,
        kind: signal.kind,
        label: signal.label,
        text: signal.text,
        sourceRefs: signal.sourceRefs,
      }));
    }
  }
  return Object.freeze(out);
}

function renderMarkdown(
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
      appendMoreLine(lines, entry.facts.length, facts.length, "facts");
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
        entry.diagnostics.length,
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
        entry.questions.length,
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

function recallSignalsForTopic(input: {
  readonly projection: ProjectionQueryView;
  readonly topic: string;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
  readonly questions: ReadonlyArray<SearchQuestionItem>;
}): ReadonlyMap<string, ReadonlyArray<ContextRecallSignal>> {
  const matcher = topicMatcher(input.topic);
  if (matcher === null) return Object.freeze(new Map());

  const mutable = new Map<string, ContextRecallSignal[]>();
  for (const fact of recallFacts(input.projection)) {
    const text = factObjectLabel(fact);
    if (!matcher(text)) continue;
    const kind = isSearchOpenLoopFact(fact) ? "open-loop" : "decision";
    addRecallSignal(mutable, {
      path: primaryRecallPath(fact.sourceRefs),
      kind,
      label:
        kind === "open-loop"
          ? "open-loop topic match"
          : "decision topic match",
      text,
      weight: 8,
      sourceRefs: fact.sourceRefs,
    });
  }

  for (const question of input.questions) {
    const text = [
      question.question,
      ...question.options,
    ].join(" ");
    if (!matcher(text)) continue;
    addRecallSignal(mutable, {
      path: primaryRecallPath(question.sourceRefs),
      kind: "question",
      label: "question topic match",
      text: question.question,
      weight: 6,
      sourceRefs: question.sourceRefs,
    });
  }

  for (const diagnostic of input.diagnostics) {
    const text = `${diagnostic.code} ${diagnostic.message}`;
    if (!matcher(text)) continue;
    addRecallSignal(mutable, {
      path: primaryRecallPath(diagnostic.sourceRefs),
      kind: "diagnostic",
      label: "diagnostic topic match",
      text: `${diagnostic.code}: ${diagnostic.message}`,
      weight: 2,
      sourceRefs: diagnostic.sourceRefs,
    });
  }

  return Object.freeze(
    new Map([...mutable.entries()].map(([path, signals]) => [
      path,
      Object.freeze(signals),
    ])),
  );
}

function recallFacts(
  projection: ProjectionQueryView,
): ReadonlyArray<FactEffect> {
  return Object.freeze([
    ...SEARCH_OPEN_LOOP_PREDICATES.flatMap((predicate) =>
      projection.facts({ predicate })
    ),
    ...SEARCH_DECISION_PREDICATES.flatMap((predicate) =>
      projection.facts({ predicate })
    ),
  ]);
}

function addRecallSignal(
  mutable: Map<string, ContextRecallSignal[]>,
  signal: Omit<ContextRecallSignal, "path"> & { readonly path: string | null },
): void {
  if (signal.path === null) return;
  const next = Object.freeze({
    path: signal.path,
    kind: signal.kind,
    label: signal.label,
    text: signal.text,
    weight: signal.weight,
    sourceRefs: signal.sourceRefs,
  });
  const signals = mutable.get(signal.path);
  if (signals === undefined) {
    mutable.set(signal.path, [next]);
  } else {
    signals.push(next);
  }
}

function primaryRecallPath(sourceRefs: ReadonlyArray<SourceRef>): string | null {
  return sourceRefs.find((ref) => ref.path.endsWith(".md"))?.path ?? null;
}

function prioritizedRecallPaths(
  recallSignalsByPath: ReadonlyMap<string, ReadonlyArray<ContextRecallSignal>>,
  excludePaths: ReadonlySet<string>,
): ReadonlyArray<string> {
  return Object.freeze(
    [...recallSignalsByPath.entries()]
      .filter(([path]) => !excludePaths.has(path))
      .sort((a, b) => {
        const score = recallSignalWeight(b[1]) - recallSignalWeight(a[1]);
        return score !== 0 ? score : a[0].localeCompare(b[0]);
      })
      .map(([path]) => path),
  );
}

function recallSignalWeight(
  signals: ReadonlyArray<ContextRecallSignal>,
): number {
  return signals.reduce((sum, signal) => sum + signal.weight, 0);
}

function topicMatcher(topic: string): ((text: string) => boolean) | null {
  const terms = normalizedTokens(topic);
  if (terms.length === 0) return null;
  return (text: string) => {
    const tokens = new Set(normalizedTokens(text));
    return terms.every((term) => tokens.has(term));
  };
}

function normalizedTokens(value: string): ReadonlyArray<string> {
  return Object.freeze(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
  );
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

function parseInput(input: unknown): ExportInput {
  const envelope = input !== null && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  const record = envelope.commandArgs !== null &&
    typeof envelope.commandArgs === "object"
    ? envelope.commandArgs as Record<string, unknown>
    : envelope;
  const flags = record.flags !== null && typeof record.flags === "object"
    ? record.flags as Record<string, unknown>
    : {};
  const topic = stringValue(record.topic) ?? stringValue(flags.topic) ?? "";
  const limit = clampLimit(numberValue(record.limit) ?? numberValue(flags.limit));
  return Object.freeze({ topic, limit });
}

function compareFacts(a: ContextFact, b: ContextFact): number {
  const predicate = a.predicate.localeCompare(b.predicate);
  return predicate !== 0 ? predicate : a.object.localeCompare(b.object);
}

function compareDiagnostics(
  a: ContextDiagnostic,
  b: ContextDiagnostic,
): number {
  const severity = a.severity.localeCompare(b.severity);
  if (severity !== 0) return severity;
  const code = a.code.localeCompare(b.code);
  return code !== 0 ? code : a.message.localeCompare(b.message);
}

function compareQuestions(
  a: ContextQuestion,
  b: ContextQuestion,
): number {
  return a.id - b.id;
}

function objectLabel(value: FactEffect["object"]): string {
  if (value.kind === "string") return value.value;
  if (value.kind === "number") return String(value.value);
  if (value.kind === "date") return value.value;
  if (value.kind === "page") return value.path;
  if (value.kind === "task") return value.stableId;
  return value.name;
}

function factObjectLabel(fact: FactEffect): string {
  const raw = objectLabel(fact.object);
  if (
    fact.object.kind !== "string" ||
    !(
      fact.predicate === "dome.daily.open_task" ||
      fact.predicate === "dome.daily.followup"
    )
  ) {
    return raw;
  }
  return dailyActionLabel(raw);
}

function dailyActionLabel(text: string): string {
  const stripped = stripDailyTaskMetadata(text);
  const dueDate = taskDueDate(text);
  const priority = taskPriority(text);
  const metadata = [
    dueDate === null ? null : `due: ${dueDate}`,
    priority === null ? null : `priority: ${priority}`,
  ].filter((item): item is string => item !== null);
  return metadata.length === 0 ? stripped : `${stripped} [${metadata.join(", ")}]`;
}

function stripDailyTaskMetadata(text: string): string {
  const stripped = text
    .replace(TASK_METADATA_MARKER, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : text;
}

function taskDueDate(text: string): string | null {
  return TASK_DUE_MARKER.exec(text)?.[1] ?? null;
}

function taskPriority(text: string): string | null {
  if (text.includes("\u{1F53A}")) return "highest";
  if (text.includes("\u{23EB}")) return "high";
  if (text.includes("\u{1F53C}")) return "medium";
  if (text.includes("\u{1F53D}")) return "low";
  if (text.includes("\u{23EC}")) return "lowest";
  return null;
}

function formatSourceRef(ref: SourceRef): string {
  const suffix = ref.range === undefined
    ? ""
    : `:${ref.range.startLine}-${ref.range.endLine}`;
  return `${ref.path}${suffix} @ ${ref.commit.slice(0, 7)}`;
}

function stripFtsMarkers(snippet: string): string {
  return snippet.replace(/\[/g, "").replace(/\]/g, "");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampLimit(raw: number | null): number {
  if (raw === null || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(25, Math.trunc(raw)));
}
