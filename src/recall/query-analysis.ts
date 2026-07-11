// recall/query-analysis: natural-language lexical query analysis.
//
// FTS callers should not need to know how many words must match. This module
// turns a question into one bounded FTS5 expression and provides the same
// minimum-match semantics for non-FTS projection-memory channels.

const MAX_TERMS = 8;

const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "at",
  "can",
  "did",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "me",
  "my",
  "of",
  "on",
  "or",
  "s",
  "should",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "who",
  "why",
  "with",
  "you",
]);

// These words commonly describe the desired answer shape rather than the
// evidence itself. They are removed only when another significant term
// remains; a direct query such as "open threads" therefore still works.
const INTENT_WORDS: ReadonlySet<string> = new Set([
  "current",
  "latest",
  "know",
  "open",
  "outcome",
  "outcomes",
  "priorities",
  "priority",
  "status",
  "tell",
  "thread",
  "threads",
  "update",
  "updates",
]);

export type RecallQuery = {
  readonly raw: string;
  readonly terms: ReadonlyArray<string>;
  readonly minimumShouldMatch: number;
  readonly fts: string | null;
};

export function analyzeRecallQuery(raw: string): RecallQuery {
  const normalized = unique(normalizedTokens(raw));
  const withoutStopwords = normalized.filter((term) => !STOPWORDS.has(term));
  const withoutIntent = withoutStopwords.filter((term) => !INTENT_WORDS.has(term));
  const selected = (
    withoutIntent.length > 0
      ? withoutIntent
      : withoutStopwords.length > 0
        ? withoutStopwords
        : normalized
  ).slice(0, MAX_TERMS);
  const terms = Object.freeze(selected);
  const minimumShouldMatch = minimumMatches(terms.length);
  return Object.freeze({
    raw,
    terms,
    minimumShouldMatch,
    fts: compileFtsQuery(terms, minimumShouldMatch),
  });
}

export function normalizedTokens(value: string): ReadonlyArray<string> {
  return Object.freeze(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
  );
}

export function significantRecallTerms(value: string): ReadonlyArray<string> {
  return analyzeRecallQuery(value).terms;
}

export function matchesRecallText(query: string, text: string): boolean {
  const analyzed = analyzeRecallQuery(query);
  if (analyzed.minimumShouldMatch === 0) return false;
  const haystack = new Set(normalizedTokens(text));
  let matches = 0;
  for (const term of analyzed.terms) {
    if (haystack.has(term)) matches += 1;
  }
  return matches >= analyzed.minimumShouldMatch;
}

function minimumMatches(termCount: number): number {
  if (termCount === 0) return 0;
  if (termCount <= 2) return termCount;
  return Math.max(2, Math.ceil(termCount * 0.4));
}

function compileFtsQuery(
  terms: ReadonlyArray<string>,
  minimumShouldMatch: number,
): string | null {
  if (terms.length === 0 || minimumShouldMatch === 0) return null;
  const escaped = terms.map((term) => `"${term.replace(/"/g, '""')}"`);
  if (minimumShouldMatch >= escaped.length) return escaped.join(" ");
  return combinations(escaped, minimumShouldMatch)
    .map((combination) => `(${combination.join(" ")})`)
    .join(" OR ");
}

function combinations<T>(
  values: ReadonlyArray<T>,
  size: number,
): ReadonlyArray<ReadonlyArray<T>> {
  const out: T[][] = [];
  const current: T[] = [];
  const visit = (start: number): void => {
    if (current.length === size) {
      out.push([...current]);
      return;
    }
    const remaining = size - current.length;
    for (let index = start; index <= values.length - remaining; index += 1) {
      const value = values[index];
      if (value === undefined) continue;
      current.push(value);
      visit(index + 1);
      current.pop();
    }
  };
  visit(0);
  return Object.freeze(out.map((entry) => Object.freeze(entry)));
}

function unique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}
