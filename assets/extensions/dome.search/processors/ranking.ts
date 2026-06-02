// Shared source-backed ranking helpers for dome.search view processors.

import type {
  DiagnosticEffect,
  FactEffect,
} from "../../../../src/core/effect";
import type { SearchDocumentResult } from "../../../../src/core/processor";

const MAX_SEARCH_CANDIDATES = 51;

const TYPE_WEIGHTS = Object.freeze(new Map<string, number>([
  ["project", 3],
  ["meeting", 2],
  ["person", 2],
  ["daily", 2],
  ["capture", 1],
  ["concept", 1],
  ["index", 1],
]));

export type SearchRankingSignal = {
  readonly kind:
    | "page-type"
    | "open-loop"
    | "decision"
    | "question"
    | "diagnostic"
    | "graph";
  readonly label: string;
  readonly weight: number;
  readonly count?: number;
};

export type SearchRanking = {
  readonly score: number;
  readonly ftsRank: number;
  readonly reasons: ReadonlyArray<string>;
  readonly signals: ReadonlyArray<SearchRankingSignal>;
};

export type SearchRankingQuestion = {
  readonly id: number;
};

export type SearchRankingInput = {
  readonly match: SearchDocumentResult;
  readonly facts: ReadonlyArray<Pick<FactEffect, "predicate">>;
  readonly diagnostics: ReadonlyArray<Pick<DiagnosticEffect, "severity">>;
  readonly questions: ReadonlyArray<SearchRankingQuestion>;
};

export type RankedSearchEntry = {
  readonly path: string;
  readonly rank: number;
  readonly ranking: SearchRanking;
};

export function expandedSearchLimit(limit: number): number {
  return Math.min(
    MAX_SEARCH_CANDIDATES,
    Math.max(limit + 1, limit * 4, 12),
  );
}

export function rankSearchCandidate(input: SearchRankingInput): SearchRanking {
  const signals = [
    pageTypeSignal(input.match),
    countedSignal({
      kind: "open-loop",
      label: "open loop",
      count: input.facts.filter(isSearchOpenLoopFact).length,
      weightPerItem: 5,
      maxWeight: 10,
    }),
    countedSignal({
      kind: "decision",
      label: "decision",
      count: input.facts.filter(isSearchDecisionFact).length,
      weightPerItem: 5,
      maxWeight: 10,
    }),
    countedSignal({
      kind: "question",
      label: "unresolved question",
      count: input.questions.length,
      weightPerItem: 3,
      maxWeight: 6,
    }),
    countedSignal({
      kind: "diagnostic",
      label: "active diagnostic",
      count: input.diagnostics.length,
      weightPerItem: 1,
      maxWeight: 2,
    }),
    countedSignal({
      kind: "graph",
      label: "graph signal",
      count: input.facts.filter(isSearchGraphFact).length,
      weightPerItem: 1,
      maxWeight: 3,
    }),
  ].filter((signal): signal is SearchRankingSignal => signal !== null);
  const score = signals.reduce((sum, signal) => sum + signal.weight, 0);
  return Object.freeze({
    score,
    ftsRank: input.match.rank,
    reasons: Object.freeze(signals.map(renderSignalReason)),
    signals: Object.freeze(signals),
  });
}

export function compareRankedSearchEntries(
  a: RankedSearchEntry,
  b: RankedSearchEntry,
): number {
  const score = b.ranking.score - a.ranking.score;
  if (score !== 0) return score;
  const fts = a.ranking.ftsRank - b.ranking.ftsRank;
  if (fts !== 0) return fts;
  return a.path.localeCompare(b.path);
}

export function isSearchOpenLoopFact(
  fact: Pick<FactEffect, "predicate">,
): boolean {
  return (
    fact.predicate === "dome.daily.open_task" ||
    fact.predicate === "dome.daily.followup" ||
    fact.predicate === "dome.intake.task" ||
    fact.predicate === "dome.intake.followup"
  );
}

export function isSearchDecisionFact(
  fact: Pick<FactEffect, "predicate">,
): boolean {
  return (
    fact.predicate === "dome.intake.decision" ||
    fact.predicate === "dome.daily.decision"
  );
}

function pageTypeSignal(
  match: SearchDocumentResult,
): SearchRankingSignal | null {
  if (match.type === null) return null;
  const weight = TYPE_WEIGHTS.get(match.type) ?? 1;
  return Object.freeze({
    kind: "page-type",
    label: `${match.type} page`,
    weight,
    count: 1,
  });
}

function countedSignal(input: {
  readonly kind: SearchRankingSignal["kind"];
  readonly label: string;
  readonly count: number;
  readonly weightPerItem: number;
  readonly maxWeight: number;
}): SearchRankingSignal | null {
  if (input.count <= 0) return null;
  return Object.freeze({
    kind: input.kind,
    label: input.label,
    weight: Math.min(input.maxWeight, input.count * input.weightPerItem),
    count: input.count,
  });
}

function isSearchGraphFact(
  fact: Pick<FactEffect, "predicate">,
): boolean {
  return (
    fact.predicate === "dome.graph.tagged" ||
    fact.predicate === "dome.graph.links_to"
  );
}

function renderSignalReason(signal: SearchRankingSignal): string {
  if (signal.count === undefined || signal.count <= 1) return signal.label;
  return `${signal.count} ${signal.label}s`;
}
