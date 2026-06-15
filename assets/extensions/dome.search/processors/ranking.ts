// Shared source-backed ranking helpers for dome.search view processors.
//
// This file is the composite TS ranking layer described in
// [[wiki/specs/cli]] §"dome query": section-deduped FTS candidates and the
// one-hop `dome.graph.links_to` expansion channel are fused via reciprocal-
// rank fusion (k=60), the fused contribution joins the source-backed signal
// sum in `rankSearchCandidate`, and `applyRecencyDecay` multiplies the top-N
// composite scores by a floored `0.995^hoursSince(lastHumanChangedAt)`
// factor (Dome-authored commits never refresh recency — that is why the
// basis is `lastHumanChangedAt`, not `lastChangedAt`). Superseded pages
// (per [[wiki/specs/page-schema]] §"Supersession (ADR pattern)") are
// multiplicatively downranked ×0.3 by reading the `dome.page.status` facts
// emitted by dome.markdown.page-status, with an explainable
// "superseded by X" signal — downranked, never filtered.

import type {
  DiagnosticEffect,
  FactEffect,
} from "../../../../src/core/effect";
import type {
  SearchDocumentResult,
  SnapshotFileInfo,
} from "../../../../src/core/processor";

import { compareStrings } from "../../../../src/core/compare";
import { isClaimFact } from "../../dome.claims/processors/claim-fact";

const MAX_SEARCH_CANDIDATES = 51;

// ----- RRF fusion constants ---------------------------------------------------
//
// k=60 is the standard reciprocal-rank-fusion constant (per docs/memory.md
// §M1 research grounding). The scale lifts 1/(k+rank) into the same numeric
// regime as the integer signal weights below while keeping the inter-rank
// deltas small (~0.16 between adjacent ranks), so source-backed memory
// signals still dominate ordering — RRF mostly replaces the old
// "ftsRank as tiebreaker" role with an explainable signal. The link channel
// runs at half weight so a page that never matched FTS (max ≈ 4.92) cannot
// outrank a direct hit (max ≈ 9.84) on fusion alone.
const RRF_K = 60;
const RRF_SCALE = 600;
const LINK_CHANNEL_WEIGHT = 0.5;
/** How many top FTS pages seed the one-hop link expansion. */
const MAX_LINK_EXPANSION_SEEDS = 10;
/** Bound on expansion-only pages pulled into the candidate set. */
export const MAX_LINK_EXPANSION_PATHS = 8;

// ----- Supersession downrank constants ------------------------------------------
//
// The multiplicative factor applied to a superseded page's composite score.
// 0.3 keeps a strongly-matching superseded page findable (history questions
// must still surface it) while reliably ranking the forward target above it
// for current-context queries. Applied as a negative-weight signal so
// "score = sum of signal weights" stays true and the downrank is
// explainable in `reasons`.
const SUPERSEDED_RANK_FACTOR = 0.3;
export const SEARCH_PAGE_STATUS_PREDICATE = "dome.page.status";
export const SEARCH_SUPERSEDED_BY_PREDICATE = "dome.page.superseded_by";
const SUPERSEDED_STATUS_VALUE = "superseded";

// ----- Recency decay constants ------------------------------------------------

const RECENCY_DECAY_PER_HOUR = 0.995;
const RECENCY_FLOOR = 0.35;
/** Bound on `getFileInfo` calls per query. */
const RECENCY_TOP_N = 25;
/** Only annotate reasons when the factor is materially below 1. */
const RECENCY_REASON_THRESHOLD = 0.99;

const TYPE_WEIGHTS = Object.freeze(new Map<string, number>([
  ["project", 3],
  ["meeting", 2],
  ["person", 2],
  ["daily", 2],
  ["capture", 1],
  ["concept", 1],
  ["index", 1],
]));

export const SEARCH_OPEN_LOOP_PREDICATES = Object.freeze([
  "dome.daily.open_task",
  "dome.daily.followup",
]);

export const SEARCH_DECISION_PREDICATES = Object.freeze([
  "dome.daily.decision",
]);

const SEARCH_OPEN_LOOP_PREDICATE_SET = new Set(SEARCH_OPEN_LOOP_PREDICATES);
const SEARCH_DECISION_PREDICATE_SET = new Set(SEARCH_DECISION_PREDICATES);

export type SearchRankingSignal = {
  readonly kind:
    | "recall"
    | "fusion"
    | "page-type"
    | "open-loop"
    | "decision"
    | "claim"
    | "question"
    | "diagnostic"
    | "graph"
    | "superseded";
  readonly label: string;
  readonly weight: number;
  readonly count?: number;
};

export type SearchRankingRecallSignal = {
  readonly label: string;
  readonly weight: number;
  readonly count?: number;
};

export type SearchRanking = {
  readonly score: number;
  readonly ftsRank: number;
  /**
   * Multiplicative recency factor in `[RECENCY_FLOOR, 1]` applied by
   * `applyRecencyDecay`; `1` before the decay pass or for pages outside the
   * top-N / without a human-authored commit.
   */
  readonly recencyFactor: number;
  readonly reasons: ReadonlyArray<string>;
  readonly signals: ReadonlyArray<SearchRankingSignal>;
};

export type SearchRankingQuestion = {
  readonly id: number;
};

/**
 * The candidate's RRF fusion contribution, computed by
 * `fuseSearchChannelsRrf`. Already scaled into composite-signal range.
 */
export type SearchRankingFusion = {
  /** Scaled RRF weight from the FTS channel; absent when not an FTS hit. */
  readonly ftsWeight?: number;
  /** Scaled RRF weight from the link-expansion channel. */
  readonly linkedWeight?: number;
  /** Distinct top FTS hits linking to/from this page. */
  readonly linkedVia?: number;
};

/**
 * The fact shape the ranker consumes: predicate always, object only when
 * the caller has it (the supersession signals read `dome.page.status` /
 * `dome.page.superseded_by` string objects; every other signal keys on the
 * predicate alone).
 */
export type SearchRankingFact = Pick<FactEffect, "predicate"> & {
  readonly object?: FactEffect["object"];
};

export type SearchRankingInput = {
  readonly match: SearchDocumentResult;
  readonly facts: ReadonlyArray<SearchRankingFact>;
  readonly diagnostics: ReadonlyArray<Pick<DiagnosticEffect, "severity">>;
  readonly questions: ReadonlyArray<SearchRankingQuestion>;
  readonly recallSignals?: ReadonlyArray<SearchRankingRecallSignal>;
  readonly fusion?: SearchRankingFusion;
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
    ...recallRankingSignals(input.recallSignals ?? Object.freeze([])),
    ...fusionRankingSignals(input.fusion),
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
    // A page carrying claims is a consolidated, load-bearing page. This is a
    // deliberately small structural nudge (weight 1, cap 3 — the lightest
    // counted signal, matching the graph signal) layered onto the same signal
    // sum as decisions/open-loops; claim line text already lives in the FTS
    // body, so term-matching is covered and this must only NUDGE consolidated
    // pages up, never dominate FTS relevance.
    countedSignal({
      kind: "claim",
      label: "claim",
      count: input.facts.filter(isSearchClaimFact).length,
      weightPerItem: 1,
      maxWeight: 3,
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
  const baseScore = roundScore(
    signals.reduce((sum, signal) => sum + signal.weight, 0),
  );
  // Multiplicative ×0.3 supersession downrank, carried as a negative-weight
  // signal so the score stays the sum of its signals and the downrank is
  // explainable ("superseded by X"). Downranked, never filtered.
  const superseded = supersededRankingSignal(input.facts, baseScore);
  if (superseded !== null) signals.push(superseded);
  const score = roundScore(
    superseded === null ? baseScore : baseScore + superseded.weight,
  );
  return Object.freeze({
    score,
    ftsRank: input.match.rank,
    recencyFactor: 1,
    reasons: Object.freeze(signals.map(renderSignalReason)),
    signals: Object.freeze(signals),
  });
}

export function compareRankedSearchEntries(
  a: Pick<RankedSearchEntry, "path" | "ranking">,
  b: Pick<RankedSearchEntry, "path" | "ranking">,
): number {
  const score = b.ranking.score - a.ranking.score;
  if (score !== 0) return score;
  const fts = a.ranking.ftsRank - b.ranking.ftsRank;
  if (fts !== 0) return fts;
  return compareStrings(a.path, b.path);
}

// ----- Section dedup ----------------------------------------------------------

/**
 * Collapse section-granular FTS rows to the best (first, i.e. best-bm25)
 * section per page, preserving the input's rank order. The surviving match
 * carries its section's id/breadcrumb/snippet/sourceRefs so query surfaces
 * stay section-granular while path-keyed joins (facts, diagnostics,
 * questions) see one row per page.
 */
export function dedupeBestSectionPerPage(
  matches: ReadonlyArray<SearchDocumentResult>,
): ReadonlyArray<SearchDocumentResult> {
  const seen = new Set<string>();
  const out: SearchDocumentResult[] = [];
  for (const match of matches) {
    if (seen.has(match.path)) continue;
    seen.add(match.path);
    out.push(match);
  }
  return Object.freeze(out);
}

// ----- Link expansion channel ---------------------------------------------------

export type LinkExpansionFact = {
  readonly subject: { readonly kind: string; readonly path?: string };
  readonly object:
    | { readonly kind: "string"; readonly value: string }
    | { readonly kind: string; readonly value?: unknown };
};

export type LinkExpansionEntry = {
  readonly path: string;
  /** 1-based rank of the best (highest-ranked) linking FTS hit. */
  readonly bestSeedRank: number;
  /** Distinct top FTS hits this page is linked from/to. */
  readonly viaCount: number;
};

/**
 * One-hop expansion over `dome.graph.links_to` facts: pages linked *from*
 * the top FTS hits (outgoing wikilinks, targets resolved against the vault's
 * markdown paths by full path or basename) and pages linking *to* them
 * (incoming). Entries are ordered by the rank of the linking hit — a page
 * linked from the #1 hit outranks one linked from the #5 hit — then by how
 * many hits link it, then by path. Seed pages themselves are excluded.
 */
export function linkExpansionChannel(input: {
  readonly ftsPaths: ReadonlyArray<string>;
  readonly linksToFacts: ReadonlyArray<LinkExpansionFact>;
  readonly allMarkdownPaths: ReadonlyArray<string>;
}): ReadonlyArray<LinkExpansionEntry> {
  const seeds = input.ftsPaths.slice(0, MAX_LINK_EXPANSION_SEEDS);
  if (seeds.length === 0) return Object.freeze([]);
  const seedRankByPath = new Map(seeds.map((path, i) => [path, i + 1]));

  const resolveTarget = buildWikilinkTargetResolver(input.allMarkdownPaths);

  // path → { bestSeedRank, viaSeeds }
  const found = new Map<string, { bestSeedRank: number; via: Set<string> }>();
  const add = (path: string, seedPath: string, seedRank: number): void => {
    if (seedRankByPath.has(path)) return; // already a direct hit
    const entry = found.get(path);
    if (entry === undefined) {
      found.set(path, { bestSeedRank: seedRank, via: new Set([seedPath]) });
    } else {
      entry.via.add(seedPath);
      if (seedRank < entry.bestSeedRank) entry.bestSeedRank = seedRank;
    }
  };

  for (const fact of input.linksToFacts) {
    if (fact.subject.kind !== "page" || fact.subject.path === undefined) continue;
    if (fact.object.kind !== "string" || typeof fact.object.value !== "string") {
      continue;
    }
    const fromPath = fact.subject.path;
    const targetPath = resolveTarget(fact.object.value);

    // Outgoing: a seed page links to `target`.
    const fromSeedRank = seedRankByPath.get(fromPath);
    if (fromSeedRank !== undefined && targetPath !== null) {
      add(targetPath, fromPath, fromSeedRank);
    }
    // Incoming: `fromPath` links to a seed page.
    if (targetPath !== null) {
      const toSeedRank = seedRankByPath.get(targetPath);
      if (toSeedRank !== undefined) {
        add(fromPath, targetPath, toSeedRank);
      }
    }
  }

  return Object.freeze(
    [...found.entries()]
      .map(([path, entry]) =>
        Object.freeze({
          path,
          bestSeedRank: entry.bestSeedRank,
          viaCount: entry.via.size,
        })
      )
      .sort((a, b) =>
        a.bestSeedRank - b.bestSeedRank ||
        b.viaCount - a.viaCount ||
        compareStrings(a.path, b.path)
      ),
  );
}

/**
 * Resolve a wikilink target string (recorded as-written by
 * `dome.graph.links`) to a vault markdown path: exact path, path without
 * `.md`, or basename (with/without `.md`), case-insensitive. Ambiguous
 * basenames resolve to the lexicographically first path for determinism.
 */
function buildWikilinkTargetResolver(
  allMarkdownPaths: ReadonlyArray<string>,
): (target: string) => string | null {
  const byKey = new Map<string, string>();
  const register = (key: string, path: string): void => {
    const normalized = key.toLowerCase();
    const existing = byKey.get(normalized);
    if (existing === undefined || compareStrings(path, existing) < 0) {
      byKey.set(normalized, path);
    }
  };
  for (const path of [...allMarkdownPaths].sort()) {
    register(path, path);
    register(path.replace(/\.md$/, ""), path);
    const base = path.split("/").at(-1) ?? path;
    register(base, path);
    register(base.replace(/\.md$/, ""), path);
  }
  return (target: string): string | null => {
    const trimmed = target.trim().toLowerCase();
    if (trimmed.length === 0) return null;
    return byKey.get(trimmed) ?? byKey.get(`${trimmed}.md`) ?? null;
  };
}

// ----- Reciprocal-rank fusion ---------------------------------------------------

/**
 * Fuse the FTS channel (page-deduped matches in bm25 order) with the link-
 * expansion channel via reciprocal-rank fusion: each channel contributes
 * `scale * weight / (k + rank)` with k=60. Returns per-path fusion weights,
 * already scaled into composite-signal range, for `rankSearchCandidate`.
 */
export function fuseSearchChannelsRrf(input: {
  readonly ftsPaths: ReadonlyArray<string>;
  readonly expansion: ReadonlyArray<LinkExpansionEntry>;
}): ReadonlyMap<string, SearchRankingFusion> {
  const out = new Map<string, {
    ftsWeight?: number;
    linkedWeight?: number;
    linkedVia?: number;
  }>();
  for (const [index, path] of input.ftsPaths.entries()) {
    const existing = out.get(path) ?? {};
    existing.ftsWeight = rrfWeight(index + 1, 1);
    out.set(path, existing);
  }
  for (const [index, entry] of input.expansion.entries()) {
    const existing = out.get(entry.path) ?? {};
    existing.linkedWeight = rrfWeight(index + 1, LINK_CHANNEL_WEIGHT);
    existing.linkedVia = entry.viaCount;
    out.set(entry.path, existing);
  }
  return Object.freeze(
    new Map(
      [...out.entries()].map(([path, fusion]) => [path, Object.freeze(fusion)]),
    ),
  );
}

function rrfWeight(rank: number, channelWeight: number): number {
  return roundScore((RRF_SCALE * channelWeight) / (RRF_K + rank));
}

function fusionRankingSignals(
  fusion: SearchRankingFusion | undefined,
): ReadonlyArray<SearchRankingSignal> {
  if (fusion === undefined) return Object.freeze([]);
  const signals: SearchRankingSignal[] = [];
  if (fusion.ftsWeight !== undefined && fusion.ftsWeight > 0) {
    signals.push(Object.freeze({
      kind: "fusion" as const,
      label: "text match",
      weight: fusion.ftsWeight,
    }));
  }
  if (fusion.linkedWeight !== undefined && fusion.linkedWeight > 0) {
    signals.push(Object.freeze({
      kind: "fusion" as const,
      label: "linked from matches",
      weight: fusion.linkedWeight,
      ...(fusion.linkedVia !== undefined ? { count: fusion.linkedVia } : {}),
    }));
  }
  return Object.freeze(signals);
}

// ----- Recency decay ------------------------------------------------------------

export type RecencyFileInfoReader = (
  path: string,
) => Promise<SnapshotFileInfo | null>;

/**
 * Multiply the composite score of the top-N ranked entries by
 * `max(0.35, 0.995^hoursSince(lastHumanChangedAt))` and re-sort. Pages whose
 * history is entirely Dome-authored (`lastHumanChangedAt === null`) and
 * pages outside the top N keep factor 1 — old-but-relevant pages are
 * dampened toward the floor, never buried. N bounds the `getFileInfo` calls
 * per query.
 */
export async function applyRecencyDecay<
  T extends { readonly path: string; readonly ranking: SearchRanking },
>(input: {
  readonly entries: ReadonlyArray<T>;
  readonly getFileInfo: RecencyFileInfoReader;
  readonly now: Date;
  readonly topN?: number;
}): Promise<ReadonlyArray<T>> {
  const topN = input.topN ?? RECENCY_TOP_N;
  const decayed = await Promise.all(
    input.entries.map(async (entry, index): Promise<T> => {
      if (index >= topN) return entry;
      const info = await input.getFileInfo(entry.path);
      const factor = recencyFactor(info, input.now);
      if (factor >= 1) return entry;
      const reasons = factor <= RECENCY_REASON_THRESHOLD
        ? Object.freeze([
          ...entry.ranking.reasons,
          `recency decay x${factor.toFixed(2)}`,
        ])
        : entry.ranking.reasons;
      return Object.freeze({
        ...entry,
        ranking: Object.freeze({
          ...entry.ranking,
          score: roundScore(entry.ranking.score * factor),
          recencyFactor: factor,
          reasons,
        }),
      });
    }),
  );
  return Object.freeze([...decayed].sort(compareRankedSearchEntries));
}

function recencyFactor(info: SnapshotFileInfo | null, now: Date): number {
  if (info === null || info.lastHumanChangedAt === null) return 1;
  const changedMs = Date.parse(info.lastHumanChangedAt);
  if (Number.isNaN(changedMs)) return 1;
  const hours = Math.max(0, (now.getTime() - changedMs) / 3_600_000);
  return Math.max(
    RECENCY_FLOOR,
    Math.min(1, RECENCY_DECAY_PER_HOUR ** hours),
  );
}

function roundScore(score: number): number {
  return Math.round(score * 100) / 100;
}

/**
 * The supersession downrank signal, or null for non-superseded pages.
 * Reads the rebuildable `dome.page.status` / `dome.page.superseded_by`
 * facts emitted by dome.markdown.page-status. Weight is the (negative)
 * delta that takes the composite base score to `base × 0.3`.
 */
function supersededRankingSignal(
  facts: ReadonlyArray<SearchRankingFact>,
  baseScore: number,
): SearchRankingSignal | null {
  const isSuperseded = facts.some(
    (fact) =>
      fact.predicate === SEARCH_PAGE_STATUS_PREDICATE &&
      factStringObject(fact)?.toLowerCase() === SUPERSEDED_STATUS_VALUE,
  );
  if (!isSuperseded) return null;
  const forward = facts
    .filter((fact) => fact.predicate === SEARCH_SUPERSEDED_BY_PREDICATE)
    .map(factStringObject)
    .find((value): value is string => value !== null);
  const downranked = roundScore(baseScore * SUPERSEDED_RANK_FACTOR);
  return Object.freeze({
    kind: "superseded" as const,
    label: forward !== undefined ? `superseded by ${forward}` : "superseded",
    weight: roundScore(downranked - baseScore),
  });
}

function factStringObject(fact: SearchRankingFact): string | null {
  if (fact.object === undefined) return null;
  if (fact.object.kind !== "string") return null;
  return typeof fact.object.value === "string" ? fact.object.value : null;
}

export function isSearchOpenLoopFact(
  fact: Pick<FactEffect, "predicate">,
): boolean {
  return SEARCH_OPEN_LOOP_PREDICATE_SET.has(fact.predicate);
}

export function isSearchDecisionFact(
  fact: Pick<FactEffect, "predicate">,
): boolean {
  return SEARCH_DECISION_PREDICATE_SET.has(fact.predicate);
}

/**
 * True when the fact is a decodable `dome.claims.claim` fact. Unlike the
 * predicate-only signals, claims carry a JSON object that must parse, so this
 * guards the optional object and defers the real decode to the shared
 * `isClaimFact` (no re-decoding here).
 */
function isSearchClaimFact(fact: SearchRankingFact): boolean {
  return fact.object !== undefined && isClaimFact(fact as FactEffect);
}

function recallRankingSignals(
  signals: ReadonlyArray<SearchRankingRecallSignal>,
): ReadonlyArray<SearchRankingSignal> {
  return Object.freeze(
    signals.map((signal) =>
      Object.freeze({
        kind: "recall" as const,
        label: signal.label,
        weight: signal.weight,
        ...(signal.count !== undefined ? { count: signal.count } : {}),
      })
    ),
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
  if (signal.kind === "graph" && signal.count > 8) {
    return "many graph signals";
  }
  return `${signal.count} ${signal.label}s`;
}
