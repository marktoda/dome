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
import type {
  ProjectionQueryView,
  SearchDocumentResult,
  Snapshot,
} from "../../../../src/core/processor";
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
  readonly kind:
    | "daily"
    | "open-loop"
    | "decision"
    | "question"
    | "diagnostic";
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

export async function dailySurfaceRecallSignalsForTopic(input: {
  readonly snapshot: Snapshot;
  readonly topic: string;
  readonly sourceRef: (path: string) => SourceRef;
  readonly now?: Date;
}): Promise<ReadonlyMap<string, ReadonlyArray<SearchRecallSignal>>> {
  const dates = dailyRecallDates(input.topic, input.now ?? new Date());
  if (dates.length === 0) return Object.freeze(new Map());

  const dateByFilename = new Map(
    dates.map((date) => [`${date.date}.md`, date]),
  );
  const mutable = new Map<string, SearchRecallSignal[]>();
  for (const path of await input.snapshot.listMarkdownFiles()) {
    const filename = path.split("/").at(-1) ?? path;
    const date = dateByFilename.get(filename);
    if (date === undefined) continue;
    addRecallSignal(mutable, {
      path,
      kind: "daily",
      label: date.label,
      text: `${date.label}: ${path}`,
      weight: 16,
      sourceRefs: Object.freeze([input.sourceRef(path)]),
    });
  }

  return freezeRecallSignalMap(mutable);
}

export function mergeRecallSignalMaps(
  maps: ReadonlyArray<ReadonlyMap<string, ReadonlyArray<SearchRecallSignal>>>,
): ReadonlyMap<string, ReadonlyArray<SearchRecallSignal>> {
  const mutable = new Map<string, SearchRecallSignal[]>();
  for (const map of maps) {
    for (const [path, signals] of map) {
      const existing = mutable.get(path);
      if (existing === undefined) {
        mutable.set(path, [...signals]);
      } else {
        existing.push(...signals);
      }
    }
  }
  return freezeRecallSignalMap(mutable);
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

export function filterDailyIntentSearchMatches(input: {
  readonly matches: ReadonlyArray<SearchDocumentResult>;
  readonly dailyRecallSignalsByPath: ReadonlyMap<
    string,
    ReadonlyArray<SearchRecallSignal>
  >;
}): ReadonlyArray<SearchDocumentResult> {
  const targetDailyPaths = new Set(input.dailyRecallSignalsByPath.keys());
  if (targetDailyPaths.size === 0) return input.matches;
  return Object.freeze(
    input.matches.filter((match) =>
      !isDailySearchMatch(match) || targetDailyPaths.has(match.path)
    ),
  );
}

function isDailySearchMatch(match: SearchDocumentResult): boolean {
  return match.type === "daily" ||
    /^(?:notes|wiki\/dailies)\/\d{4}-\d{2}-\d{2}\.md$/.test(match.path);
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

function freezeRecallSignalMap(
  mutable: Map<string, SearchRecallSignal[]>,
): ReadonlyMap<string, ReadonlyArray<SearchRecallSignal>> {
  return Object.freeze(
    new Map([...mutable.entries()].map(([path, signals]) => [
      path,
      Object.freeze(signals),
    ])),
  );
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

type DailyRecallDate = {
  readonly date: string;
  readonly label: string;
};

function dailyRecallDates(
  topic: string,
  now: Date,
): ReadonlyArray<DailyRecallDate> {
  const normalized = normalizedTokens(topic);
  const tokens = new Set(normalized);
  const dates = new Map<string, string>();
  for (const explicit of explicitDates(topic)) {
    dates.set(explicit, `daily surface for ${explicit}`);
  }
  if (tokens.has("today") || tokens.has("daily")) {
    dates.set(localDateString(now), "current daily surface");
  }
  if (tokens.has("yesterday")) {
    dates.set(localDateString(addDays(now, -1)), "previous daily surface");
  }
  if (tokens.has("tomorrow")) {
    dates.set(localDateString(addDays(now, 1)), "next daily surface");
  }
  return Object.freeze(
    [...dates.entries()].map(([date, label]) =>
      Object.freeze({ date, label })
    ),
  );
}

function explicitDates(topic: string): ReadonlyArray<string> {
  const out: string[] = [];
  for (const match of topic.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    if (isRealDate(date)) out.push(date);
  }
  return Object.freeze(out);
}

function isRealDate(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === day;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function localDateString(date: Date): string {
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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
