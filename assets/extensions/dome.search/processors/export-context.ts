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
  defineProcessorImplementation,
  type ProcessorContext,
  type SearchDocumentResult,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";
import {
  questionAutomationPolicy,
} from "../../../../src/question-resolution";
import {
  searchFactObjectLabel,
} from "./labels";
import {
  dailySurfaceOpenLoopsForContext,
  type DailySurfaceContextOpenLoop,
} from "./daily-surface";
import {
  openLoopSurfaceKey,
} from "../../dome.daily/processors/daily-shared";
import {
  groupByMatchingPath,
  questionItemFromProjection,
  uniqueSourceRefs,
  type SearchQuestionItem,
} from "./related";
import {
  dailySurfaceRecallSignalsForTopic,
  filterDailyIntentSearchMatches,
  mergeRecallSignalMaps,
  prioritizedRecallPaths,
  recallSignalsForTopic,
  type SearchRecallSignal,
} from "./recall";
import {
  applyRecencyDecay,
  compareRankedSearchEntries,
  dedupeBestSectionPerPage,
  expandedSearchLimit,
  fuseSearchChannelsRrf,
  isSearchDecisionFact,
  isSearchOpenLoopFact,
  linkExpansionChannel,
  rankSearchCandidate,
  MAX_LINK_EXPANSION_PATHS,
  type SearchRanking,
  type SearchRankingFusion,
} from "./ranking";
import {
  compareTopicRelevance,
  topicRelevantItems,
} from "./topic-relevance";
import { renderMarkdown, SCHEMA, MAX_RELATED_ROWS } from "./packet-render";

import { compareStrings } from "../../../../src/core/compare";

const DEFAULT_LIMIT = 8;
const MAX_ENTRY_SUMMARY_ROWS = 5;
const MAX_RECALL_PATHS = 24;

const exportContext = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (ctx.projection === undefined) {
      throw new Error(
        "dome.search.export-context: ctx.projection is undefined; view-phase processors require a ProjectionQueryView",
      );
    }

    const projection = ctx.projection;
    const input = parseInput(ctx.input);

    // Fetch FTS candidates, recall signals, link expansion, and RRF fusion.
    const collected = await collectCandidates(ctx, input, projection);

    // Score candidates, apply recency decay, sort, and slice to limit.
    const ranked = await rankCandidates(collected, input, ctx);

    // Fetch pinned open loops from daily surface.
    const dailySurfaceOpenLoops = await dailySurfaceOpenLoopsForContext({
      ctx,
      recallSignalsByPath: collected.recallSignalsByPath,
      maxRows: MAX_RELATED_ROWS,
    });

    // Assemble cross-entry overview (read-first, open loops, decisions, etc.).
    const overview = buildOverview(
      input.topic,
      ranked.entries,
      collected.recallSignalsByPath,
      dailySurfaceOpenLoops,
    );

    const scope = uniqueSourceRefs(
      [
        ...ranked.entries.flatMap((entry) => [
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
        entries: ranked.entries.length,
      }),
      hasMore: Object.freeze({
        entries: ranked.hasMoreEntries,
      }),
      overview,
      markdown: renderMarkdown(input.topic, overview, ranked.entries, ranked.hasMoreEntries),
      entries: Object.freeze(ranked.entries.map(publicContextEntry)),
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

export type ContextEntry = {
  readonly path: string;
  readonly title: string;
  readonly category: string;
  readonly type: string | null;
  readonly sectionId: string | null;
  readonly breadcrumb: string | null;
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

export type ContextOverview = {
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

type PinnedContextOpenLoop = ContextOpenLoop | DailySurfaceContextOpenLoop;

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

// Intermediate type for collected retrieval inputs.
type CollectedCandidates = {
  readonly candidateMatches: ReadonlyArray<SearchDocumentResult>;
  readonly recallSignalsByPath: ReadonlyMap<string, ReadonlyArray<ContextRecallSignal>>;
  readonly fusionByPath: ReadonlyMap<string, SearchRankingFusion>;
  readonly factsByPath: ReadonlyMap<string, ReadonlyArray<FactEffect>>;
  readonly diagnosticsByPath: ReadonlyMap<string, ReadonlyArray<DiagnosticEffect>>;
  readonly questionsByPath: ReadonlyMap<string, ReadonlyArray<SearchQuestionItem>>;
};

// Intermediate type for scored, sliced candidates with built ContextEntries.
type RankedCandidates = {
  readonly entries: ReadonlyArray<ContextEntry>;
  readonly hasMoreEntries: boolean;
};

async function collectCandidates(
  ctx: ProcessorContext,
  input: ExportInput,
  projection: NonNullable<ProcessorContext["projection"]>,
): Promise<CollectedCandidates> {
  const searchMatches = projection.searchDocuments({
    query: input.topic,
    limit: expandedSearchLimit(input.limit),
  });
  const allDiagnostics = projection.diagnostics();
  const allQuestions = projection
    .questions({ resolved: false })
    .map(questionItemFromProjection);
  const topicRecallSignalsByPath = recallSignalsForTopic({
    projection,
    topic: input.topic,
    diagnostics: allDiagnostics,
    questions: allQuestions,
  });
  const dailyRecallSignalsByPath = await dailySurfaceRecallSignalsForTopic({
    snapshot: ctx.snapshot,
    topic: input.topic,
    sourceRef: ctx.sourceRef,
    now: ctx.now(),
  });
  const recallSignalsByPath = mergeRecallSignalMaps([
    topicRecallSignalsByPath,
    dailyRecallSignalsByPath,
  ]);
  // FTS rows are section-granular; collapse to the best section per page
  // before the path-keyed joins and channel fusion.
  const filteredSearchMatches = dedupeBestSectionPerPage(
    filterDailyIntentSearchMatches({
      matches: searchMatches,
      dailyRecallSignalsByPath,
    }),
  );
  const searchMatchPaths = new Set(
    filteredSearchMatches.map((match) => match.path),
  );
  const recalledPaths = prioritizedRecallPaths(
    recallSignalsByPath,
    searchMatchPaths,
  ).slice(0, MAX_RECALL_PATHS);
  const recalledMatches = filterDailyIntentSearchMatches({
    matches: projection.documentsByPath(recalledPaths),
    dailyRecallSignalsByPath,
  });
  // One-hop link expansion over dome.graph.links_to facts from the top
  // FTS hits, fused with the FTS channel via reciprocal-rank fusion —
  // same retrieval substrate as `dome query`.
  const ftsPaths = filteredSearchMatches.map((match) => match.path);
  const expansion = linkExpansionChannel({
    ftsPaths,
    linksToFacts: projection.facts({ predicate: "dome.graph.links_to" }),
    allMarkdownPaths: await ctx.snapshot.listMarkdownFiles(),
  });
  const fusionByPath = fuseSearchChannelsRrf({ ftsPaths, expansion });
  const recalledPathSet = new Set(recalledMatches.map((match) => match.path));
  // Expansion candidates must exclude pages already present as FTS hits —
  // a hit beyond the recall-prioritization cut that is also linked from a
  // top hit would otherwise enter `candidateMatches` twice and render as a
  // duplicate entry.
  const expansionPaths = expansion
    .map((entry) => entry.path)
    .filter(
      (path) => !recalledPathSet.has(path) && !searchMatchPaths.has(path),
    )
    .slice(0, MAX_LINK_EXPANSION_PATHS);
  const expansionMatches = filterDailyIntentSearchMatches({
    matches: projection.documentsByPath(expansionPaths),
    dailyRecallSignalsByPath,
  });
  const candidateMatches = Object.freeze([
    ...filteredSearchMatches,
    ...recalledMatches,
    ...expansionMatches,
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
  return {
    candidateMatches,
    recallSignalsByPath,
    fusionByPath,
    factsByPath,
    diagnosticsByPath,
    questionsByPath,
  };
}

async function rankCandidates(
  collected: CollectedCandidates,
  input: ExportInput,
  ctx: ProcessorContext,
): Promise<RankedCandidates> {
  // Score each candidate, sort by rank, apply recency decay, then slice to limit.
  const rankedMatches = await applyRecencyDecay({
    entries: collected.candidateMatches
      .map((match) => {
        const fusion = collected.fusionByPath.get(match.path);
        return Object.freeze({
          ...match,
          ranking: rankSearchCandidate({
            match,
            facts: collected.factsByPath.get(match.path) ?? Object.freeze([]),
            diagnostics: collected.diagnosticsByPath.get(match.path) ??
              Object.freeze([]),
            questions: collected.questionsByPath.get(match.path) ?? Object.freeze([]),
            recallSignals: collected.recallSignalsByPath.get(match.path) ??
              Object.freeze([]),
            ...(fusion !== undefined ? { fusion } : {}),
          }),
          facts: collected.factsByPath.get(match.path) ?? Object.freeze([]),
          diagnostics: collected.diagnosticsByPath.get(match.path) ?? Object.freeze([]),
          questions: collected.questionsByPath.get(match.path) ?? Object.freeze([]),
        });
      })
      .sort(compareRankedSearchEntries),
    getFileInfo: ctx.snapshot.getFileInfo,
    now: ctx.now(),
  });
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
  return { entries: Object.freeze(entries), hasMoreEntries };
}

function contextEntryFromMatch(
  topic: string,
  match: SearchDocumentResult,
  facts: ReadonlyArray<FactEffect>,
  diagnostics: ReadonlyArray<DiagnosticEffect>,
  questions: ReadonlyArray<SearchQuestionItem>,
  ranking: SearchRanking,
): ContextEntry {
  // Snippets arrive marker-free from the projection (the FTS snippet() call
  // uses empty highlight markers), so wikilink/checkbox brackets survive.
  const snippet = match.snippet;
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
    sectionId: match.sectionId,
    breadcrumb: match.breadcrumb,
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
    sectionId: entry.sectionId,
    breadcrumb: entry.breadcrumb,
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
  pinnedOpenLoops: ReadonlyArray<PinnedContextOpenLoop> = Object.freeze([]),
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
  pinned: ReadonlyArray<PinnedContextOpenLoop> = Object.freeze([]),
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
  const predicate = compareStrings(a.predicate, b.predicate);
  return predicate !== 0 ? predicate : compareStrings(a.object, b.object);
}

function compareDiagnostics(
  a: ContextDiagnostic,
  b: ContextDiagnostic,
): number {
  const severity = compareStrings(a.severity, b.severity);
  if (severity !== 0) return severity;
  const code = compareStrings(a.code, b.code);
  return code !== 0 ? code : compareStrings(a.message, b.message);
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
