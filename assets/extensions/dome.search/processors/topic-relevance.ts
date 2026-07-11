// Shared topic-relevance helpers for query-time search surfaces.

import {
  normalizedTokens,
  significantRecallTerms,
} from "../../../../src/recall/query-analysis";

export function topicRelevantItems<T>(
  items: ReadonlyArray<T>,
  topic: string,
  textFor: (item: T) => string,
): ReadonlyArray<T> {
  const tokens = significantTopicTokens(topic);
  if (tokens.length === 0 || items.length <= 1) return items;

  const scored = items.map((item, index) =>
    Object.freeze({
      item,
      index,
      score: topicRelevanceScore(tokens, textFor(item)),
    })
  );
  const relevant = scored.filter((entry) => entry.score > 0);
  if (relevant.length === 0) return items;
  return Object.freeze(
    relevant
      .sort((a, b) => (b.score - a.score) || (a.index - b.index))
      .map((entry) => entry.item),
  );
}

export function compareTopicRelevance(
  topic: string,
  aText: string,
  bText: string,
): number {
  const tokens = significantTopicTokens(topic);
  if (tokens.length === 0) return 0;
  return topicRelevanceScore(tokens, bText) -
    topicRelevanceScore(tokens, aText);
}

export function boundedTopicRows<T>(input: {
  readonly rows: ReadonlyArray<T>;
  readonly textFor: (row: T) => string;
  readonly topic: string;
  readonly limit: number;
  readonly compare?: (a: T, b: T) => number;
}): ReadonlyArray<T> {
  if (input.rows.length <= input.limit) return input.rows;
  const tokens = significantTopicTokens(input.topic);
  return Object.freeze(
    input.rows
      .map((row, index) =>
        Object.freeze({
          row,
          index,
          topicScore: topicRelevanceScore(tokens, input.textFor(row)),
        })
      )
      .sort((a, b) =>
        (b.topicScore - a.topicScore) ||
        (input.compare?.(a.row, b.row) ?? 0) ||
        (a.index - b.index)
      )
      .slice(0, input.limit)
      .map((entry) => entry.row),
  );
}

const significantTopicTokens = significantRecallTerms;

function topicRelevanceScore(
  topicTokens: ReadonlyArray<string>,
  value: string,
): number {
  if (topicTokens.length === 0) return 0;
  const tokens = new Set(normalizedTokens(value));
  let score = 0;
  for (const token of topicTokens) {
    if (tokens.has(token)) score += 1;
  }
  return score;
}
