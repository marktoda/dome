// dome.search.query — view-phase adopted-state query.
//
// The processor reads the projection query view, not SQLite. It returns one
// structured ViewEffect so CLI/MCP/future surfaces can render the same data.

import {
  viewEffect,
  type Effect,
  type FactEffect,
  type ViewEffect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
  type SearchDocumentResult,
} from "../../../../src/core/processor";
import {
  groupByMatchingPath,
  questionItemFromProjection,
  uniqueSourceRefs,
} from "./related";
import { searchFactObjectLabel } from "./labels";
import { isClaimFact } from "./claims-fact";
import {
  dailySurfaceRecallSignalsForTopic,
  filterDailyIntentSearchMatches,
  mergeRecallSignalMaps,
  prioritizedRecallPaths,
  recallSignalsForTopic,
} from "./recall";
import {
  applyRecencyDecay,
  compareRankedSearchEntries,
  dedupeBestSectionPerPage,
  expandedSearchLimit,
  fuseSearchChannelsRrf,
  linkExpansionChannel,
  rankSearchCandidate,
  isSearchDecisionFact,
  isSearchOpenLoopFact,
  MAX_LINK_EXPANSION_PATHS,
} from "./ranking";
import { boundedTopicRows } from "./topic-relevance";
import {
  clampLimit,
  commandArgsRecord,
  flagsRecord,
  numberValue,
  questionSearchText,
  stringValue,
} from "./search-input";

import { compareStrings } from "../../../../src/core/compare";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_QUERY_RECALL_PATHS = 24;
const MAX_RELATED_ROWS = 8;

const searchQuery = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (ctx.projection === undefined) {
      throw new Error(
        "dome.search.query: ctx.projection is undefined; view-phase processors require a ProjectionQueryView",
      );
    }

    const input = parseQueryInput(ctx.input);
    const searchMatches = ctx.projection.searchDocuments({
      query: input.text,
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      limit: expandedSearchLimit(input.limit),
    });
    const allDiagnostics = ctx.projection.diagnostics();
    const allQuestions = ctx.projection
      .questions({ resolved: false })
      .map(questionItemFromProjection);
    const topicRecallSignalsByPath = recallSignalsForTopic({
      projection: ctx.projection,
      topic: input.text,
      diagnostics: allDiagnostics,
      questions: allQuestions,
    });
    const dailyRecallSignalsByPath = await dailySurfaceRecallSignalsForTopic({
      snapshot: ctx.snapshot,
      topic: input.text,
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
    ).slice(0, MAX_QUERY_RECALL_PATHS);
    const recalledMatches = filterDailyIntentSearchMatches({
      matches: ctx.projection
        .documentsByPath(recalledPaths)
        .filter((match) => matchSatisfiesFilters(match, input)),
      dailyRecallSignalsByPath,
    });
    // One-hop link expansion over dome.graph.links_to facts from the top
    // FTS hits, fused with the FTS channel via reciprocal-rank fusion.
    const ftsPaths = filteredSearchMatches.map((match) => match.path);
    const expansion = linkExpansionChannel({
      ftsPaths,
      linksToFacts: ctx.projection.facts({
        predicate: "dome.graph.links_to",
      }),
      allMarkdownPaths: await ctx.snapshot.listMarkdownFiles(),
    });
    const fusionByPath = fuseSearchChannelsRrf({ ftsPaths, expansion });
    const recalledPathSet = new Set(recalledMatches.map((match) => match.path));
    // Expansion candidates must exclude pages already present as FTS hits —
    // a hit beyond the recall-prioritization cut that is also linked from a
    // top hit would otherwise enter `candidateMatches` twice and render as a
    // duplicate result row.
    const expansionPaths = expansion
      .map((entry) => entry.path)
      .filter(
        (path) => !recalledPathSet.has(path) && !searchMatchPaths.has(path),
      )
      .slice(0, MAX_LINK_EXPANSION_PATHS);
    const expansionMatches = filterDailyIntentSearchMatches({
      matches: ctx.projection
        .documentsByPath(expansionPaths)
        .filter((match) => matchSatisfiesFilters(match, input)),
      dailyRecallSignalsByPath,
    });
    const candidateMatches = Object.freeze([
      ...filteredSearchMatches,
      ...recalledMatches,
      ...expansionMatches,
    ]);
    const factsByPath = factsForMatches(ctx, candidateMatches);
    const matchPaths = new Set(candidateMatches.map((match) => match.path));
    const diagnosticsByPath = groupByMatchingPath(allDiagnostics, matchPaths);
    const questionsByPath = groupByMatchingPath(allQuestions, matchPaths);
    const rankedMatches = await applyRecencyDecay({
      entries: candidateMatches
        .map((match) => {
          const fusion = fusionByPath.get(match.path);
          return Object.freeze({
            ...match,
            ranking: rankSearchCandidate({
              match,
              facts: factsByPath.get(match.path) ?? Object.freeze([]),
              diagnostics: diagnosticsByPath.get(match.path) ??
                Object.freeze([]),
              questions: questionsByPath.get(match.path) ?? Object.freeze([]),
              recallSignals: recallSignalsByPath.get(match.path) ??
                Object.freeze([]),
              ...(fusion !== undefined ? { fusion } : {}),
            }),
          });
        })
        .sort(compareRankedSearchEntries),
      getFileInfo: ctx.snapshot.getFileInfo,
      now: ctx.now(),
    });
    const matches = Object.freeze(rankedMatches.slice(0, input.limit));
    const outputFactsByPath = boundedFactsByPath(input.text, matches, factsByPath);
    const outputDiagnosticsByPath = boundedRowsByPath({
      paths: matches.map((match) => match.path),
      rowsByPath: diagnosticsByPath,
      textFor: (diagnostic) => `${diagnostic.code} ${diagnostic.message}`,
      topic: input.text,
    });
    const outputQuestionsByPath = boundedRowsByPath({
      paths: matches.map((match) => match.path),
      rowsByPath: questionsByPath,
      textFor: questionSearchText,
      topic: input.text,
    });
    const hasMoreMatches = rankedMatches.length > matches.length;
    const data = Object.freeze({
      schema: "dome.search.query/v1",
      query: input.text,
      filters: Object.freeze({
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
      }),
      limit: input.limit,
      shown: Object.freeze({
        matches: matches.length,
      }),
      hasMore: Object.freeze({
        matches: hasMoreMatches,
      }),
      matches: Object.freeze(
        matches.map((match) =>
          Object.freeze({
            path: match.path,
            title: match.title,
            category: match.category,
            type: match.type,
            sectionId: match.sectionId,
            breadcrumb: match.breadcrumb,
            snippet: match.snippet,
            rank: match.rank,
            ranking: match.ranking,
            sourceRefs: match.sourceRefs,
            facts: outputFactsByPath.get(match.path) ?? Object.freeze([]),
            diagnostics: outputDiagnosticsByPath.get(match.path) ??
              Object.freeze([]),
            questions: outputQuestionsByPath.get(match.path) ??
              Object.freeze([]),
          }),
        ),
      ),
    });

    const effect: ViewEffect = viewEffect({
      name: "dome.search.query",
      content: {
        kind: "structured",
        schema: "dome.search.query/v1",
        data,
      },
      scope: uniqueSourceRefs([
        ...matches.flatMap((match) => [...match.sourceRefs]),
        ...matches.flatMap((match) =>
          outputFactsByPath
            .get(match.path)
            ?.flatMap((fact) => [...fact.sourceRefs]) ?? []
        ),
        ...matches.flatMap((match) =>
          outputDiagnosticsByPath
            .get(match.path)
            ?.flatMap((diagnostic) => [...diagnostic.sourceRefs]) ?? []
        ),
        ...matches.flatMap((match) =>
          outputQuestionsByPath
            .get(match.path)
            ?.flatMap((question) => [...question.sourceRefs]) ?? []
        ),
      ]),
    });
    return [effect];
  },
});

export default searchQuery;

type QueryInput = {
  readonly text: string;
  readonly category?: string;
  readonly type?: string;
  readonly limit: number;
};

function parseQueryInput(input: unknown): QueryInput {
  const record = commandArgsRecord(input);
  const flags = flagsRecord(record);

  const text = stringValue(record.text) ?? stringValue(flags.q) ?? "";
  const category = stringValue(record.category) ?? stringValue(flags.category);
  const type = stringValue(record.type) ?? stringValue(flags.type);
  const limit = clampLimit(
    numberValue(record.limit) ?? numberValue(flags.limit),
    { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT },
  );
  return Object.freeze({
    text,
    ...(category !== null ? { category } : {}),
    ...(type !== null ? { type } : {}),
    limit,
  });
}

function factsForMatches(
  ctx: ProcessorContext,
  matches: ReadonlyArray<SearchDocumentResult>,
): ReadonlyMap<string, ReadonlyArray<FactEffect>> {
  if (ctx.projection === undefined) return Object.freeze(new Map());
  const out = new Map<string, ReadonlyArray<FactEffect>>();
  for (const match of matches) {
    out.set(
      match.path,
      ctx.projection.facts({
        subjectKind: "page",
        subjectId: match.path,
      }),
    );
  }
  return out;
}

function boundedFactsByPath(
  topic: string,
  matches: ReadonlyArray<SearchDocumentResult>,
  factsByPath: ReadonlyMap<string, ReadonlyArray<FactEffect>>,
): ReadonlyMap<string, ReadonlyArray<FactEffect>> {
  const out = new Map<string, ReadonlyArray<FactEffect>>();
  for (const match of matches) {
    out.set(
      match.path,
      boundedRelatedRows({
        rows: factsByPath.get(match.path) ?? Object.freeze([]),
        textFor: factSearchText,
        compare: compareFacts,
        topic,
      }),
    );
  }
  return Object.freeze(out);
}

function boundedRowsByPath<T>(input: {
  readonly paths: ReadonlyArray<string>;
  readonly rowsByPath: ReadonlyMap<string, ReadonlyArray<T>>;
  readonly textFor: (row: T) => string;
  readonly topic: string;
}): ReadonlyMap<string, ReadonlyArray<T>> {
  const out = new Map<string, ReadonlyArray<T>>();
  for (const path of input.paths) {
    out.set(
      path,
      boundedRelatedRows({
        rows: input.rowsByPath.get(path) ?? Object.freeze([]),
        textFor: input.textFor,
        topic: input.topic,
      }),
    );
  }
  return Object.freeze(out);
}

function boundedRelatedRows<T>(input: {
  readonly rows: ReadonlyArray<T>;
  readonly textFor: (row: T) => string;
  readonly topic: string;
  readonly compare?: (a: T, b: T) => number;
}): ReadonlyArray<T> {
  return boundedTopicRows({
    rows: input.rows,
    textFor: input.textFor,
    topic: input.topic,
    limit: MAX_RELATED_ROWS,
    ...(input.compare !== undefined ? { compare: input.compare } : {}),
  });
}

function factSearchText(fact: FactEffect): string {
  return `${fact.predicate} ${searchFactObjectLabel(fact)}`;
}

function compareFacts(a: FactEffect, b: FactEffect): number {
  return factPriority(a) - factPriority(b) ||
    compareStrings(a.predicate, b.predicate) ||
    compareStrings(searchFactObjectLabel(a), searchFactObjectLabel(b));
}

export function factPriority(fact: FactEffect): number {
  if (isSearchOpenLoopFact(fact)) return 0;
  if (isSearchDecisionFact(fact)) return 1;
  if (isClaimFact(fact)) return 1; // load-bearing; tie with decisions, break by predicate/label
  if (isGraphFact(fact)) return 3;
  return 2;
}

function isGraphFact(fact: FactEffect): boolean {
  return fact.predicate === "dome.graph.links_to" ||
    fact.predicate === "dome.graph.tagged";
}

function matchSatisfiesFilters(
  match: SearchDocumentResult,
  input: QueryInput,
): boolean {
  if (input.category !== undefined && match.category !== input.category) {
    return false;
  }
  if (input.type !== undefined && match.type !== input.type) {
    return false;
  }
  return true;
}
