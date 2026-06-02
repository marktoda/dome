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
  type SearchDocumentResult,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";
import {
  questionAutomationLabel,
  questionAutomationPolicy,
} from "../../../../src/question-resolution";
import {
  searchDailyActionLabel,
  searchFactObjectLabel,
} from "./labels";
import {
  actionItemsFromMarkdown,
  openLoopStableId,
  openLoopSurfaceKey,
  openSourceBackedOpenLoopsFromMarkdown,
  type DailyOpenLoopSource,
  type MarkdownActionItem,
} from "../../dome.daily/processors/daily-shared";
import {
  groupByMatchingPath,
  questionItemFromProjection,
  uniqueSourceRefs,
  type SearchQuestionItem,
} from "./related";
import {
  dailySurfaceRecallSignalsForTopic,
  mergeRecallSignalMaps,
  prioritizedRecallPaths,
  recallSignalsForTopic,
  type SearchRecallSignal,
} from "./recall";
import {
  compareRankedSearchEntries,
  expandedSearchLimit,
  isSearchDecisionFact,
  isSearchOpenLoopFact,
  rankSearchCandidate,
  type SearchRanking,
} from "./ranking";
import {
  compareTopicRelevance,
  topicRelevantItems,
} from "./topic-relevance";

const SCHEMA = "dome.search.export-context/v1";
const DEFAULT_LIMIT = 8;
const MAX_ENTRY_SUMMARY_ROWS = 5;
const MAX_RELATED_ROWS = 8;
const MAX_DAILY_SURFACE_PATHS = 3;
const MAX_RECALL_PATHS = 24;

const exportContext: Processor = defineProcessor({
  id: "dome.search.export-context",
  version: "0.1.12",
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
    const recallSignalsByPath = mergeRecallSignalMaps([
      recallSignalsForTopic({
        projection,
        topic: input.topic,
        diagnostics: allDiagnostics,
        questions: allQuestions,
      }),
      await dailySurfaceRecallSignalsForTopic({
        snapshot: ctx.snapshot,
        topic: input.topic,
        sourceRef: ctx.sourceRef,
      }),
    ]);
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
        input.topic,
        match,
        match.facts,
        match.diagnostics,
        match.questions,
        match.ranking,
      ),
    );
    const dailySurfaceOpenLoops = await dailySurfaceOpenLoopsForContext({
      ctx,
      recallSignalsByPath,
    });
    const overview = buildOverview(
      input.topic,
      entries,
      recallSignalsByPath,
      dailySurfaceOpenLoops,
    );
    const scope = uniqueSourceRefs(
      [
        ...entries.flatMap((entry) => [
          ...entry.sourceRefs,
          ...entry.facts.flatMap((fact) => fact.sourceRefs),
          ...entry.diagnostics.flatMap((diagnostic) => diagnostic.sourceRefs),
          ...entry.questions.flatMap((question) => question.sourceRefs),
        ]),
        ...overview.openLoops.flatMap((item) => item.sourceRefs),
        ...overview.decisions.flatMap((item) => item.sourceRefs),
        ...overview.unresolvedQuestions.flatMap((item) => item.sourceRefs),
        ...overview.diagnostics.flatMap((item) => item.sourceRefs),
        ...overview.recallSignals.flatMap((item) => item.sourceRefs),
      ],
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
      entries: Object.freeze(entries.map(publicContextEntry)),
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
  readonly summary: ReadonlyArray<ContextSummary>;
  readonly facts: ReadonlyArray<ContextFact>;
  readonly allFacts: ReadonlyArray<ContextFact>;
  readonly factCount: number;
  readonly diagnostics: ReadonlyArray<ContextDiagnostic>;
  readonly allDiagnostics: ReadonlyArray<ContextDiagnostic>;
  readonly diagnosticCount: number;
  readonly questions: ReadonlyArray<ContextQuestion>;
  readonly allQuestions: ReadonlyArray<ContextQuestion>;
  readonly questionCount: number;
};

type PublicContextEntry = Omit<
  ContextEntry,
  | "allFacts"
  | "factCount"
  | "allDiagnostics"
  | "diagnosticCount"
  | "allQuestions"
  | "questionCount"
>;

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

type ContextSummary = {
  readonly kind:
    | "match"
    | "open-loop"
    | "decision"
    | "question"
    | "diagnostic";
  readonly text: string;
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

type ContextRecallSignal = SearchRecallSignal;

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
  topic: string,
  match: SearchDocumentResult,
  facts: ReadonlyArray<FactEffect>,
  diagnostics: ReadonlyArray<DiagnosticEffect>,
  questions: ReadonlyArray<SearchQuestionItem>,
  ranking: SearchRanking,
): ContextEntry {
  const snippet = stripFtsMarkers(match.snippet);
  const allContextFacts = Object.freeze(
    facts
      .map((fact) =>
        Object.freeze({
          predicate: fact.predicate,
          object: searchFactObjectLabel(fact),
          assertion: fact.assertion,
          sourceRefs: Object.freeze([...fact.sourceRefs]),
        })
      )
      .sort(compareFactsForTopic(topic)),
  );
  const allContextDiagnostics = Object.freeze(
    diagnostics
      .map((diagnostic) =>
        Object.freeze({
          severity: diagnostic.severity,
          code: diagnostic.code,
          message: diagnostic.message,
          sourceRefs: Object.freeze([...diagnostic.sourceRefs]),
        })
      )
      .sort(compareDiagnosticsForTopic(topic)),
  );
  const allContextQuestions = Object.freeze(
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
      .sort(compareQuestionsForTopic(topic)),
  );
  const contextFacts = allContextFacts.slice(0, MAX_RELATED_ROWS);
  const contextDiagnostics = allContextDiagnostics.slice(0, MAX_RELATED_ROWS);
  const contextQuestions = allContextQuestions.slice(0, MAX_RELATED_ROWS);
  return Object.freeze({
    path: match.path,
    title: match.title,
    category: match.category,
    type: match.type,
    snippet,
    rank: match.rank,
    ranking,
    sourceRefs: Object.freeze([...match.sourceRefs]),
    summary: sourceBackedSummary({
      snippet,
      sourceRefs: match.sourceRefs,
      facts: allContextFacts,
      diagnostics: allContextDiagnostics,
      questions: allContextQuestions,
      topic,
    }),
    facts: contextFacts,
    allFacts: allContextFacts,
    factCount: allContextFacts.length,
    diagnostics: contextDiagnostics,
    allDiagnostics: allContextDiagnostics,
    diagnosticCount: allContextDiagnostics.length,
    questions: contextQuestions,
    allQuestions: allContextQuestions,
    questionCount: allContextQuestions.length,
  });
}

function publicContextEntry(entry: ContextEntry): PublicContextEntry {
  return Object.freeze({
    path: entry.path,
    title: entry.title,
    category: entry.category,
    type: entry.type,
    snippet: entry.snippet,
    rank: entry.rank,
    ranking: entry.ranking,
    sourceRefs: entry.sourceRefs,
    summary: entry.summary,
    facts: entry.facts,
    diagnostics: entry.diagnostics,
    questions: entry.questions,
  });
}

function sourceBackedSummary(input: {
  readonly topic: string;
  readonly snippet: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
  readonly facts: ReadonlyArray<ContextFact>;
  readonly diagnostics: ReadonlyArray<ContextDiagnostic>;
  readonly questions: ReadonlyArray<ContextQuestion>;
}): ReadonlyArray<ContextSummary> {
  const rows: ContextSummary[] = [];
  if (input.snippet.trim().length > 0) {
    rows.push(Object.freeze({
      kind: "match",
      text: compactText(input.snippet),
      sourceRefs: Object.freeze([...input.sourceRefs]),
    }));
  }
  appendFactSummaries(
    rows,
    "decision",
    topicRelevantItems(
      input.facts.filter(isSearchDecisionFact),
      input.topic,
      factSearchText,
    ),
  );
  appendFactSummaries(
    rows,
    "open-loop",
    topicRelevantItems(
      input.facts.filter(isSearchOpenLoopFact),
      input.topic,
      factSearchText,
    ),
  );
  for (
    const question of topicRelevantItems(
      input.questions,
      input.topic,
      questionSearchText,
    )
  ) {
    rows.push(Object.freeze({
      kind: "question",
      text: question.question,
      sourceRefs: question.sourceRefs,
    }));
    if (rows.length >= MAX_ENTRY_SUMMARY_ROWS) break;
  }
  if (rows.length < MAX_ENTRY_SUMMARY_ROWS) {
    for (
      const diagnostic of topicRelevantItems(
        input.diagnostics,
        input.topic,
        diagnosticSearchText,
      )
    ) {
      rows.push(Object.freeze({
        kind: "diagnostic",
        text: `${diagnostic.code}: ${diagnostic.message}`,
        sourceRefs: diagnostic.sourceRefs,
      }));
      if (rows.length >= MAX_ENTRY_SUMMARY_ROWS) break;
    }
  }
  return Object.freeze(rows.slice(0, MAX_ENTRY_SUMMARY_ROWS));
}

function appendFactSummaries(
  rows: ContextSummary[],
  kind: "open-loop" | "decision",
  facts: ReadonlyArray<ContextFact>,
): void {
  for (const fact of facts) {
    if (rows.length >= MAX_ENTRY_SUMMARY_ROWS) return;
    rows.push(Object.freeze({
      kind,
      text: fact.object,
      sourceRefs: fact.sourceRefs,
    }));
  }
}

function buildOverview(
  topic: string,
  entries: ReadonlyArray<ContextEntry>,
  recallSignalsByPath: ReadonlyMap<string, ReadonlyArray<ContextRecallSignal>>,
  pinnedOpenLoops: ReadonlyArray<ContextOpenLoop> = Object.freeze([]),
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
      uniqueOpenLoops(entries, topic, pinnedOpenLoops).slice(
        0,
        MAX_RELATED_ROWS,
      ),
    ),
    decisions: Object.freeze(
      uniqueDecisions(entries, topic).slice(0, MAX_RELATED_ROWS),
    ),
    unresolvedQuestions: Object.freeze(
      uniqueQuestions(entries, topic).slice(0, MAX_RELATED_ROWS),
    ),
    diagnostics: Object.freeze(
      uniqueDiagnostics(entries, topic).slice(0, MAX_RELATED_ROWS),
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
  topic: string,
  pinned: ReadonlyArray<ContextOpenLoop> = Object.freeze([]),
): ReadonlyArray<ContextOpenLoop> {
  const seen = new Set<string>();
  const out: ContextOpenLoop[] = [];
  for (const item of pinned) {
    const key = openLoopOverviewKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  const topicRelevantFacts = topicRelevantItems(
    entries.flatMap((entry) =>
      entry.allFacts
        .filter(isSearchOpenLoopFact)
        .map((fact) =>
          Object.freeze({
            path: entry.path,
            predicate: fact.predicate,
            text: fact.object,
            sourceRefs: fact.sourceRefs,
          })
        )
    ),
    topic,
    (item) => item.text,
  );

  for (const item of topicRelevantFacts) {
    const key = openLoopOverviewKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return Object.freeze(out);
}

async function dailySurfaceOpenLoopsForContext(input: {
  readonly ctx: ProcessorContext;
  readonly recallSignalsByPath: ReadonlyMap<
    string,
    ReadonlyArray<ContextRecallSignal>
  >;
}): Promise<ReadonlyArray<ContextOpenLoop>> {
  const paths = dailySurfacePaths(input.recallSignalsByPath);
  const out: ContextOpenLoop[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const content = await input.ctx.snapshot.readFile(path);
    if (content === null) continue;
    const items = dailySurfaceActionItems(path, content);
    for (const item of items) {
      const loop = contextOpenLoopFromDailySurfaceItem(input.ctx, path, item);
      const key = openLoopOverviewKey(loop);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(loop);
      if (out.length >= MAX_RELATED_ROWS) return Object.freeze(out);
    }
  }
  return Object.freeze(out);
}

function dailySurfacePaths(
  recallSignalsByPath: ReadonlyMap<string, ReadonlyArray<ContextRecallSignal>>,
): ReadonlyArray<string> {
  return Object.freeze(
    [...recallSignalsByPath.entries()]
      .filter(([, signals]) => signals.some((signal) => signal.kind === "daily"))
      .sort((a, b) => {
        const weightCmp = maxDailySignalWeight(b[1]) -
          maxDailySignalWeight(a[1]);
        return weightCmp !== 0 ? weightCmp : a[0].localeCompare(b[0]);
      })
      .map(([path]) => path)
      .slice(0, MAX_DAILY_SURFACE_PATHS),
  );
}

function maxDailySignalWeight(
  signals: ReadonlyArray<ContextRecallSignal>,
): number {
  return signals
    .filter((signal) => signal.kind === "daily")
    .reduce((max, signal) => Math.max(max, signal.weight), 0);
}

type DailySurfaceActionItem = DailyOpenLoopSource & {
  readonly sourceBacked: boolean;
};

function dailySurfaceActionItems(
  path: string,
  content: string,
): ReadonlyArray<DailySurfaceActionItem> {
  const sourceBacked = openSourceBackedOpenLoopsFromMarkdown({
    path,
    content,
  }).map((item) =>
    Object.freeze({
      ...item,
      sourceBacked: true,
    })
  );
  const direct = actionItemsFromMarkdown(content).map((item) =>
    dailySurfaceActionItemFromMarkdownItem(path, item)
  );
  return Object.freeze(
    [...sourceBacked, ...direct].sort((a, b) =>
      a.line - b.line || a.body.localeCompare(b.body)
    ),
  );
}

function dailySurfaceActionItemFromMarkdownItem(
  path: string,
  item: MarkdownActionItem,
): DailySurfaceActionItem {
  return Object.freeze({
    line: item.line,
    stableId: openLoopStableId({ sourcePath: path, body: item.body }),
    body: item.body,
    followup: item.followup,
    sourcePath: path,
    sourceBacked: false,
  });
}

function contextOpenLoopFromDailySurfaceItem(
  ctx: ProcessorContext,
  path: string,
  item: DailySurfaceActionItem,
): ContextOpenLoop {
  const surfaceRef = ctx.sourceRef(
    path,
    { startLine: item.line, endLine: item.line },
    item.stableId,
  );
  const sourceRefs = uniqueSourceRefs([
    surfaceRef,
    ...(item.sourceBacked && item.sourcePath !== path
      ? [ctx.sourceRef(item.sourcePath, undefined, item.stableId)]
      : []),
  ]);
  return Object.freeze({
    path,
    predicate: item.followup
      ? "dome.daily.followup"
      : "dome.daily.open_task",
    text: searchDailyActionLabel(item.body),
    sourceRefs,
  });
}

function openLoopOverviewKey(item: ContextOpenLoop): string {
  if (
    item.predicate === "dome.daily.open_task" ||
    item.predicate === "dome.daily.followup"
  ) {
    return [
      item.predicate,
      openLoopSurfaceKey({ body: item.text }),
    ].join("\u0000");
  }
  return [
    item.path,
    item.predicate,
    openLoopSurfaceKey({ body: item.text }),
  ].join("\u0000");
}

function uniqueDecisions(
  entries: ReadonlyArray<ContextEntry>,
  topic: string,
): ReadonlyArray<ContextDecision> {
  const seen = new Set<string>();
  const out: ContextDecision[] = [];
  for (const entry of entries) {
    for (const fact of entry.allFacts) {
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
  return Object.freeze(topicRelevantItems(out, topic, (item) => item.text));
}

function uniqueQuestions(
  entries: ReadonlyArray<ContextEntry>,
  topic: string,
): ReadonlyArray<ContextQuestionSummary> {
  const seen = new Set<number>();
  const out: ContextQuestionSummary[] = [];
  for (const entry of entries) {
    for (const question of entry.allQuestions) {
      if (seen.has(question.id)) continue;
      seen.add(question.id);
      out.push(Object.freeze({
        ...question,
        path: entry.path,
      }));
    }
  }
  return Object.freeze(topicRelevantItems(out, topic, questionSearchText));
}

function uniqueDiagnostics(
  entries: ReadonlyArray<ContextEntry>,
  topic: string,
): ReadonlyArray<ContextDiagnosticSummary> {
  const seen = new Set<string>();
  const out: ContextDiagnosticSummary[] = [];
  for (const entry of entries) {
    for (const diagnostic of entry.allDiagnostics) {
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
  return Object.freeze(topicRelevantItems(out, topic, diagnosticSearchText));
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

function compareFactsForTopic(
  topic: string,
): (a: ContextFact, b: ContextFact) => number {
  return (a, b) =>
    compareTopicRelevance(topic, factSearchText(a), factSearchText(b)) ||
    compareFacts(a, b);
}

function compareDiagnosticsForTopic(
  topic: string,
): (a: ContextDiagnostic, b: ContextDiagnostic) => number {
  return (a, b) =>
    compareTopicRelevance(
      topic,
      diagnosticSearchText(a),
      diagnosticSearchText(b),
    ) || compareDiagnostics(a, b);
}

function compareQuestionsForTopic(
  topic: string,
): (a: ContextQuestion, b: ContextQuestion) => number {
  return (a, b) =>
    compareTopicRelevance(topic, questionSearchText(a), questionSearchText(b)) ||
    compareQuestions(a, b);
}

function factSearchText(fact: ContextFact): string {
  return `${fact.predicate} ${fact.object}`;
}

function diagnosticSearchText(diagnostic: ContextDiagnostic): string {
  return `${diagnostic.code} ${diagnostic.message}`;
}

function questionSearchText(question: ContextQuestion): string {
  return [
    question.question,
    ...question.options,
    question.metadata?.recommendedAnswer ?? "",
    question.metadata?.ownerNeededReason ?? "",
  ].join(" ");
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

function compactText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 220) return normalized;
  return `${normalized.slice(0, 217).trimEnd()}...`;
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
