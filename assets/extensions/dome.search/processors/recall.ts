// Shared projection-memory recall helpers for dome.search view processors.
//
// FTS is only one projection over the vault. Some relevant pages are discoverable
// because an extracted open loop, decision, question, or diagnostic on that page
// matches the topic even when the page body does not. Query and context-packet
// surfaces share that recall path here so their behavior stays coherent.

import type {
  DiagnosticEffect,
  FactEffect,
} from "../../../../src/core/effect";
import type { ProjectionQueryView } from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";
import { searchFactObjectLabel } from "./labels";
import {
  isSearchOpenLoopFact,
  SEARCH_DECISION_PREDICATES,
  SEARCH_OPEN_LOOP_PREDICATES,
  type SearchRankingRecallSignal,
} from "./ranking";

export type SearchRecallSignal = SearchRankingRecallSignal & {
  readonly path: string;
  readonly kind: "open-loop" | "decision" | "question" | "diagnostic";
  readonly text: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

export type SearchRecallQuestion = {
  readonly question: string;
  readonly options?: ReadonlyArray<string> | undefined;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

export function recallSignalsForTopic(input: {
  readonly projection: ProjectionQueryView;
  readonly topic: string;
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
  readonly questions: ReadonlyArray<SearchRecallQuestion>;
}): ReadonlyMap<string, ReadonlyArray<SearchRecallSignal>> {
  const matcher = topicMatcher(input.topic);
  if (matcher === null) return Object.freeze(new Map());

  const mutable = new Map<string, SearchRecallSignal[]>();
  for (const fact of recallFacts(input.projection)) {
    const text = searchFactObjectLabel(fact);
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
      ...(question.options ?? Object.freeze([])),
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

export function prioritizedRecallPaths(
  recallSignalsByPath: ReadonlyMap<string, ReadonlyArray<SearchRecallSignal>>,
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
  mutable: Map<string, SearchRecallSignal[]>,
  signal: Omit<SearchRecallSignal, "path"> & { readonly path: string | null },
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

function recallSignalWeight(
  signals: ReadonlyArray<SearchRecallSignal>,
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
