// Preference promotion (memory-quality M5) — the shared deterministic core.
//
// One library, three consumers: the dome.agent.preference-signals counter
// (facts), dome.agent.preference-promotion (questions), and
// dome.agent.preference-promotion-answer (the gated core.md writer that
// owns the promoted-preferences block).
// Everything here is a pure function of file contents — no clock, no model,
// no I/O — so the counter's `dome.preference.*` facts are rebuildable by
// construction per [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]].
//
// Normative contract: docs/wiki/specs/preferences.md. Signal grammar:
//
//   - YYYY-MM-DD [+|-] <topic-slug>:: <rule text> [(source: [[...]])]
//
// Confidence: Wilson 95% lower bound on (+)/((+)+(−)) over the 30-day
// window × linear freshness decay (1.0 at age 0 → 0.0 at 90 days since the
// topic's last signal). The reference "today" is the newest signal date in
// the file, NOT the wall clock.

import {
  containsHtmlCommentDelimiter,
  findGeneratedBlock,
  generatedBlockMarkers,
} from "../../../../src/core/generated-block";

import { compareStrings } from "../../../../src/core/compare";

// ----- Constants ------------------------------------------------------------

/** The append-only preference-signal page (vault-layout.md convention). */
export const PREFERENCE_SIGNALS_PATH = "preferences/signals.md";

/** Signals within this many days of the reference date count (inclusive). */
export const PREFERENCE_WINDOW_DAYS = 30;
/** Same-sign signals in window needed to make a topic a candidate. */
export const PREFERENCE_PROMOTION_THRESHOLD = 3;
/** Opposite-sign signals in window that retire a topic to `rebutted`. */
export const PREFERENCE_REBUTTAL_THRESHOLD = 3;
/** Freshness decays linearly to 0 at this age (days since last signal). */
export const PREFERENCE_FRESHNESS_HORIZON_DAYS = 90;

/** The counter's fact predicate (namespace `dome.preference.*`). */
export const PREFERENCE_TOPIC_PREDICATE = "dome.preference.topic";

/** QuestionEffect idempotency-key prefix for promotion questions. */
export const PREFERENCE_PROMOTION_KEY_PREFIX =
  "dome.agent.preference-promotion:";

/** QuestionEffect idempotency-key prefix for demotion questions (WS1 pruning). */
export const PREFERENCE_DEMOTION_KEY_PREFIX =
  "dome.agent.preference-demotion:";

/**
 * A `promoted` topic whose recomputed confidence (same Wilson × freshness
 * formula that promoted it) falls below this floor becomes a demotion
 * candidate. Freshness alone gets there: no signals for 90 days → freshness
 * 0 → confidence 0.
 */
export const DEMOTE_BELOW_CONFIDENCE = 0.15;

/** The marker-delimited generated block in core.md (M3 reserved it; M5 owns it). */
const PROMOTED_BLOCK_OWNER = "dome.agent";
const PROMOTED_BLOCK_NAME = "promoted-preferences";
const PROMOTED_BLOCK_MARKERS = generatedBlockMarkers(
  PROMOTED_BLOCK_OWNER,
  PROMOTED_BLOCK_NAME,
);
export const PROMOTED_PREFERENCES_START = PROMOTED_BLOCK_MARKERS.start;
export const PROMOTED_PREFERENCES_END = PROMOTED_BLOCK_MARKERS.end;

/**
 * The promoted-preferences block as an `(owner, block)` anomaly-scan target —
 * what the answer handler feeds `generatedBlockAnomalyDiagnostics` so marker
 * damage in core.md (duplicate pairs, half-open markers) surfaces as an info
 * diagnostic at splice time instead of staying invisible.
 */
export const PROMOTED_PREFERENCES_BLOCK: {
  readonly owner: string;
  readonly block: string;
} = Object.freeze({
  owner: PROMOTED_BLOCK_OWNER,
  block: PROMOTED_BLOCK_NAME,
});

/** The rule text that marks a `-` line as an owner rejection tombstone. */
export const OWNER_REJECTION_RULE = "rejected by owner";

// ----- Signal parsing -------------------------------------------------------

export type PreferenceSignal = {
  /** 1-based line number in preferences/signals.md. */
  readonly line: number;
  /** YYYY-MM-DD. */
  readonly date: string;
  readonly sign: "+" | "-";
  readonly topic: string;
  /** Rule text with the optional trailing `(source: [[...]])` stripped. */
  readonly rule: string;
  /** The `[[...]]` source wikilink target, when present. */
  readonly source: string | null;
  /** True when this is the answer handler's rejection tombstone. */
  readonly ownerRejection: boolean;
  /** The raw line, verbatim — quoted as evidence in promotion questions. */
  readonly raw: string;
};

export type SignalParseProblem = {
  readonly line: number;
  readonly text: string;
};

export type ParsedSignals = {
  readonly signals: ReadonlyArray<PreferenceSignal>;
  /** `- ` list lines that failed the grammar (one info diagnostic, never a crash). */
  readonly problems: ReadonlyArray<SignalParseProblem>;
};

const SIGNAL_LINE_RE =
  /^- (\d{4}-\d{2}-\d{2}) ([+-]) ([a-z0-9]+(?:-[a-z0-9]+)*):: (.+)$/;
const SOURCE_SUFFIX_RE = /\s*\(source:\s*\[\[([^\]]+)\]\]\)\s*$/;

/**
 * HTML-comment delimiters are banned in signal lines: rule text is `(.+)`,
 * so a crafted correction could otherwise smuggle the promoted-preferences
 * block markers through owner promotion into core.md and mis-bound the
 * generated block (the marker-injection gotcha). Checked at parse time here
 * and again, defense in depth, at splice time in `splicePromotedPreference`.
 * The predicate is the core grammar primitive's
 * `containsHtmlCommentDelimiter` (re-exported below for consumers).
 */
export { containsHtmlCommentDelimiter };

/**
 * Parse preferences/signals.md. Blank lines, headings, and HTML comments are
 * ignored; a `- ` list line that fails the grammar is reported as a problem
 * (malformed lines degrade to one info diagnostic — config-fallback
 * temperament, never a thrown error). Lines with an unparseable date
 * (e.g. 2026-13-45) are also problems.
 */
export function parsePreferenceSignals(content: string): ParsedSignals {
  const signals: PreferenceSignal[] = [];
  const problems: SignalParseProblem[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (!trimmed.startsWith("- ")) continue; // headings, prose, comments
    if (containsHtmlCommentDelimiter(trimmed)) {
      // Marker-injection guard: a signal line carrying `<!--` / `-->` is
      // malformed regardless of the rest of its grammar.
      problems.push(Object.freeze({ line: i + 1, text: trimmed }));
      continue;
    }
    const match = SIGNAL_LINE_RE.exec(trimmed);
    if (match === null) {
      problems.push(Object.freeze({ line: i + 1, text: trimmed }));
      continue;
    }
    const [, date, sign, topic, rest] = match as unknown as [
      string,
      string,
      "+" | "-",
      string,
      string,
    ];
    if (!isValidDate(date)) {
      problems.push(Object.freeze({ line: i + 1, text: trimmed }));
      continue;
    }
    const sourceMatch = SOURCE_SUFFIX_RE.exec(rest);
    const rule = (
      sourceMatch === null ? rest : rest.slice(0, sourceMatch.index)
    ).trim();
    if (rule.length === 0) {
      problems.push(Object.freeze({ line: i + 1, text: trimmed }));
      continue;
    }
    signals.push(
      Object.freeze({
        line: i + 1,
        date,
        sign,
        topic,
        rule,
        source: sourceMatch?.[1] ?? null,
        ownerRejection: sign === "-" && rule === OWNER_REJECTION_RULE,
        raw: trimmed,
      }),
    );
  }
  return Object.freeze({
    signals: Object.freeze(signals),
    problems: Object.freeze(problems),
  });
}

function isValidDate(date: string): boolean {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === date;
}

// ----- Confidence formula ---------------------------------------------------

const WILSON_Z = 1.96;

/**
 * Wilson 95% lower bound on the success share given `positive` successes out
 * of `total` trials. `total = 0` → 0. Pure; documented in preferences.md
 * §"The confidence formula".
 */
export function wilsonLowerBound(positive: number, total: number): number {
  if (total <= 0) return 0;
  const n = total;
  const p = positive / n;
  const z2 = WILSON_Z * WILSON_Z;
  const numerator =
    p +
    z2 / (2 * n) -
    WILSON_Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return numerator / (1 + z2 / n);
}

/** Linear freshness decay: 1.0 at age 0 → 0.0 at 90 days, clamped. */
export function preferenceFreshness(daysSinceLastSignal: number): number {
  return Math.max(
    0,
    1 - Math.max(0, daysSinceLastSignal) / PREFERENCE_FRESHNESS_HORIZON_DAYS,
  );
}

/**
 * confidence = wilson95(plusInWindow, plusInWindow + minusInWindow)
 *            × freshness(daysSinceLastSignal), rounded to 4 decimals so
 * emitted facts and question metadata are byte-stable.
 */
export function preferenceConfidence(input: {
  readonly plusInWindow: number;
  readonly minusInWindow: number;
  readonly daysSinceLastSignal: number;
}): number {
  const raw =
    wilsonLowerBound(
      input.plusInWindow,
      input.plusInWindow + input.minusInWindow,
    ) * preferenceFreshness(input.daysSinceLastSignal);
  return Math.round(raw * 10_000) / 10_000;
}

// ----- The promoted block in core.md ----------------------------------------

const PROMOTED_LINE_RE = /^- ([a-z0-9]+(?:-[a-z0-9]+)*):: /;
const PROMOTED_ENTRY_RE = /^- ([a-z0-9]+(?:-[a-z0-9]+)*):: (.+)$/;
const CONFIDENCE_SUFFIX_RE = /\s*\(confidence \d+(?:\.\d+)?\)$/;

/** Topic slugs currently in core.md's promoted-preferences block. */
export function promotedTopics(
  coreContent: string | null,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const line of promotedBlockLines(coreContent)) {
    const match = PROMOTED_LINE_RE.exec(line);
    if (match?.[1] !== undefined) out.add(match[1]);
  }
  return out;
}

/** One parsed entry of the promoted-preferences block in core.md. */
export type PromotedPreferenceEntry = {
  readonly topic: string;
  /** Rule text with the trailing `(confidence 0.NN)` suffix stripped. */
  readonly rule: string;
  /** 1-based line number in core.md (sourceRef anchor for demotion questions). */
  readonly line: number;
};

/**
 * Parse the promoted-preferences block into entries (the demotion side of
 * the lifecycle hashes and splices the BLOCK's rule text, not the latest
 * signal's). The `(confidence 0.NN)` suffix `renderPromotedLine` appends is
 * stripped; a hand-edited entry without it keeps its full rule text.
 */
export function promotedPreferenceEntries(
  coreContent: string | null,
): ReadonlyArray<PromotedPreferenceEntry> {
  if (coreContent === null) return Object.freeze([]);
  const bounds = promotedBlockBounds(coreContent);
  if (bounds === null) return Object.freeze([]);
  const lines = coreContent.split("\n");
  const out: PromotedPreferenceEntry[] = [];
  for (let i = bounds.startIndex + 1; i < bounds.endIndex; i += 1) {
    const match = PROMOTED_ENTRY_RE.exec((lines[i] ?? "").trim());
    if (match === null) continue;
    const [, topic, rest] = match as unknown as [string, string, string];
    out.push(
      Object.freeze({
        topic,
        rule: rest.replace(CONFIDENCE_SUFFIX_RE, "").trim(),
        line: i + 1,
      }),
    );
  }
  return Object.freeze(out);
}

/**
 * Splice a topic's entry OUT of the promoted-preferences block (owner-
 * mediated demotion). Block markers and every other line — including the
 * marker pair itself when the last entry goes — are preserved verbatim.
 * Byte-identical input is returned for an unknown topic or an absent block,
 * so callers can use `next === coreContent` as the retry-idempotency check
 * (same pattern as `splicePromotedPreference`).
 */
export function removePromotedPreference(input: {
  readonly coreContent: string;
  readonly topic: string;
}): string {
  const bounds = promotedBlockBounds(input.coreContent);
  if (bounds === null) return input.coreContent;
  const lines = input.coreContent.split("\n");
  const kept = lines.filter((line, index) => {
    if (index <= bounds.startIndex || index >= bounds.endIndex) return true;
    return PROMOTED_LINE_RE.exec(line.trim())?.[1] !== input.topic;
  });
  if (kept.length === lines.length) return input.coreContent;
  return kept.join("\n");
}

type PromotedBlockBounds = {
  /** Line index of the start-marker line. */
  readonly startIndex: number;
  /** Line index of the end-marker line. */
  readonly endIndex: number;
};

/**
 * Locate the promoted-preferences block via the core grammar primitive's
 * line-anchored scan: a marker counts only when it is the entire (trimmed)
 * line. A raw indexOf would also match prose or fenced *mentions* of the
 * marker text — or, before the parse/splice guards existed, marker text
 * smuggled through a promoted rule — and mis-bound the block, leaking rule
 * text outside it.
 */
function promotedBlockBounds(content: string): PromotedBlockBounds | null {
  const { range } = findGeneratedBlock(
    content,
    PROMOTED_BLOCK_OWNER,
    PROMOTED_BLOCK_NAME,
  );
  if (range === null) return null;
  return Object.freeze({
    startIndex: range.startLine - 1,
    endIndex: range.endLine - 1,
  });
}

function promotedBlockLines(
  coreContent: string | null,
): ReadonlyArray<string> {
  if (coreContent === null) return Object.freeze([]);
  const bounds = promotedBlockBounds(coreContent);
  if (bounds === null) return Object.freeze([]);
  return Object.freeze(
    coreContent
      .split("\n")
      .slice(bounds.startIndex + 1, bounds.endIndex)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

/** One sorted entry per promoted rule: `- <topic>:: <rule> (confidence 0.NN)`. */
export function renderPromotedLine(input: {
  readonly topic: string;
  readonly rule: string;
  readonly confidence: number;
}): string {
  return `- ${input.topic}:: ${input.rule} (confidence ${input.confidence.toFixed(2)})`;
}

const CORE_SKELETON = "# Core memory\n\n## Standing preferences\n";
const STANDING_PREFERENCES_HEADING_RE = /^## Standing preferences[ \t]*$/m;

/**
 * Splice a promoted rule into core.md's generated block: replace the topic's
 * existing line or insert it, keep entries sorted by topic, create the block
 * when absent (after `## Standing preferences` when present, appended
 * otherwise), and create the page itself when `coreContent` is null.
 * Idempotent: promoting the same (topic, rule, confidence) twice returns
 * byte-identical content.
 *
 * Marker-injection defense in depth (behind the parse-time ban in
 * `parsePreferenceSignals`): HTML-comment delimiters are stripped from the
 * rule before rendering, so rule text can never carry the block markers into
 * core.md; and the existing block is bounded by the line-anchored scan in
 * `promotedBlockBounds`, never a raw indexOf.
 */
export function splicePromotedPreference(input: {
  readonly coreContent: string | null;
  readonly topic: string;
  readonly rule: string;
  readonly confidence: number;
}): string {
  const content = input.coreContent ?? CORE_SKELETON;
  const rule = stripHtmlCommentDelimiters(input.rule);
  const entry = renderPromotedLine({
    topic: input.topic,
    rule,
    confidence: input.confidence,
  });

  const contentLines = content.split("\n");
  const bounds = promotedBlockBounds(content);

  const kept = promotedBlockLines(content).filter(
    (line) => PROMOTED_LINE_RE.exec(line)?.[1] !== input.topic,
  );
  const blockLines = [
    PROMOTED_PREFERENCES_START,
    ...[...kept, entry].sort((a, b) => compareStrings(a, b)),
    PROMOTED_PREFERENCES_END,
  ];

  if (bounds !== null) {
    return [
      ...contentLines.slice(0, bounds.startIndex),
      ...blockLines,
      ...contentLines.slice(bounds.endIndex + 1),
    ].join("\n");
  }

  const block = blockLines.join("\n");
  const heading = STANDING_PREFERENCES_HEADING_RE.exec(content);
  if (heading !== null && heading.index !== undefined) {
    const insertAt = heading.index + heading[0].length;
    return `${content.slice(0, insertAt)}\n\n${block}${content.slice(insertAt)}`;
  }
  return `${content.replace(/\s+$/, "")}\n\n${block}\n`;
}

/**
 * Strip the block markers and any leftover `<!--` / `-->` delimiters from
 * rule text, re-collapsing the whitespace. Pure sanitization — the rendered
 * entry can never carry comment syntax.
 */
function stripHtmlCommentDelimiters(text: string): string {
  if (!containsHtmlCommentDelimiter(text)) return text;
  return text
    .replaceAll(PROMOTED_PREFERENCES_START, " ")
    .replaceAll(PROMOTED_PREFERENCES_END, " ")
    .replace(/<!--|-->/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ----- Topic aggregation (the counter + the promotion gate) -----------------

export type PreferenceTopicState =
  | "rejected"
  | "promoted"
  | "rebutted"
  | "candidate"
  | "building";

export type PreferenceTopic = {
  readonly topic: string;
  /** `+` signals dated within the 30-day window of the reference date. */
  readonly plusInWindow: number;
  /** `-` signals dated within the window (tombstones included). */
  readonly minusInWindow: number;
  /** Oldest / newest signal dates for the topic (any age). */
  readonly firstSignal: string;
  readonly lastSignal: string;
  readonly state: PreferenceTopicState;
  /** The candidate rule: the most recent `+` line's rule text (null if none). */
  readonly rule: string | null;
  /** FNV-1a hash of the candidate rule (null when rule is null). */
  readonly ruleHash: string | null;
  /** Wilson × freshness at the reference date. */
  readonly confidence: number;
  /** In-window evidence signals, oldest first (quoted in questions). */
  readonly evidence: ReadonlyArray<PreferenceSignal>;
  /** The topic's most recent signal (sourceRef anchor for facts). */
  readonly lastSignalLine: PreferenceSignal;
};

export type PreferenceTopicCollection = {
  /** Newest signal date in the file — the deterministic reference "today". */
  readonly referenceDate: string | null;
  readonly topics: ReadonlyArray<PreferenceTopic>;
  readonly problems: ReadonlyArray<SignalParseProblem>;
};

/**
 * Aggregate parsed signals into per-topic summaries. Deterministic per
 * (signalsContent, coreContent): the reference date is the newest signal
 * date in the file — no clock. State machine (first match wins):
 * rejected → promoted → rebutted → candidate → building.
 */
export function collectPreferenceTopics(input: {
  readonly signalsContent: string | null;
  readonly coreContent: string | null;
}): PreferenceTopicCollection {
  if (input.signalsContent === null) {
    return Object.freeze({
      referenceDate: null,
      topics: Object.freeze([]),
      problems: Object.freeze([]),
    });
  }
  const parsed = parsePreferenceSignals(input.signalsContent);
  const promoted = promotedTopics(input.coreContent);

  const referenceDate = parsed.signals.reduce<string | null>(
    (max, signal) =>
      max === null || signal.date > max ? signal.date : max,
    null,
  );
  if (referenceDate === null) {
    return Object.freeze({
      referenceDate: null,
      topics: Object.freeze([]),
      problems: parsed.problems,
    });
  }

  const byTopic = new Map<string, PreferenceSignal[]>();
  for (const signal of parsed.signals) {
    const list = byTopic.get(signal.topic) ?? [];
    list.push(signal);
    byTopic.set(signal.topic, list);
  }

  const topics: PreferenceTopic[] = [];
  for (const [topic, signals] of [...byTopic.entries()].sort((a, b) =>
    compareStrings(a[0], b[0]),
  )) {
    const inWindow = signals.filter(
      (signal) =>
        wholeDaysBetween(signal.date, referenceDate) <=
        PREFERENCE_WINDOW_DAYS,
    );
    const plusInWindow = inWindow.filter((s) => s.sign === "+").length;
    const minusInWindow = inWindow.filter((s) => s.sign === "-").length;
    const dates = signals.map((s) => s.date).sort();
    const firstSignal = dates[0] ?? referenceDate;
    const lastSignal = dates.at(-1) ?? referenceDate;
    // The most recent `+` line (file order breaks date ties: later line wins).
    const latestPlus = [...signals]
      .filter((s) => s.sign === "+")
      .sort((a, b) => compareStrings(a.date, b.date) || a.line - b.line)
      .at(-1);
    const rule = latestPlus?.rule ?? null;
    const state: PreferenceTopicState = signals.some((s) => s.ownerRejection)
      ? "rejected"
      : promoted.has(topic)
        ? "promoted"
        : minusInWindow >= PREFERENCE_REBUTTAL_THRESHOLD
          ? "rebutted"
          : plusInWindow >= PREFERENCE_PROMOTION_THRESHOLD
            ? "candidate"
            : "building";
    const lastSignalLine = [...signals]
      .sort((a, b) => compareStrings(a.date, b.date) || a.line - b.line)
      .at(-1) as PreferenceSignal;
    topics.push(
      Object.freeze({
        topic,
        plusInWindow,
        minusInWindow,
        firstSignal,
        lastSignal,
        state,
        rule,
        ruleHash: rule === null ? null : fnv1aHex(rule),
        confidence: preferenceConfidence({
          plusInWindow,
          minusInWindow,
          daysSinceLastSignal: wholeDaysBetween(lastSignal, referenceDate),
        }),
        evidence: Object.freeze(
          [...inWindow].sort(
            (a, b) => compareStrings(a.date, b.date) || a.line - b.line,
          ),
        ),
        lastSignalLine,
      }),
    );
  }

  return Object.freeze({
    referenceDate,
    topics: Object.freeze(topics),
    problems: parsed.problems,
  });
}

/** Whole days from `from` to `to` (both YYYY-MM-DD), clamped at 0. */
export function wholeDaysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return 0;
  return Math.max(0, Math.round((toMs - fromMs) / 86_400_000));
}

// ----- Fact value (byte-stable JSON) -----------------------------------------

/** The JSON value shape recorded in a `dome.preference.topic` fact. */
export type PreferenceTopicFactValue = {
  readonly topic: string;
  readonly plusInWindow: number;
  readonly minusInWindow: number;
  readonly firstSignal: string;
  readonly lastSignal: string;
  readonly state: PreferenceTopicState;
  readonly rule: string | null;
  readonly confidence: number;
};

/** Encode the fact value (stable key order — facts must be byte-stable). */
export function preferenceTopicFactValue(topic: PreferenceTopic): string {
  const value: PreferenceTopicFactValue = {
    topic: topic.topic,
    plusInWindow: topic.plusInWindow,
    minusInWindow: topic.minusInWindow,
    firstSignal: topic.firstSignal,
    lastSignal: topic.lastSignal,
    state: topic.state,
    rule: topic.rule,
    confidence: topic.confidence,
  };
  return JSON.stringify(value);
}

/** Decode a fact value; null when the JSON is not the expected shape. */
export function parsePreferenceTopicFactValue(
  raw: string,
): PreferenceTopicFactValue | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.topic !== "string") return null;
  if (typeof record.plusInWindow !== "number") return null;
  if (typeof record.minusInWindow !== "number") return null;
  if (typeof record.firstSignal !== "string") return null;
  if (typeof record.lastSignal !== "string") return null;
  if (
    record.state !== "rejected" &&
    record.state !== "promoted" &&
    record.state !== "rebutted" &&
    record.state !== "candidate" &&
    record.state !== "building"
  ) {
    return null;
  }
  if (typeof record.rule !== "string" && record.rule !== null) return null;
  if (typeof record.confidence !== "number") return null;
  return Object.freeze({
    topic: record.topic,
    plusInWindow: record.plusInWindow,
    minusInWindow: record.minusInWindow,
    firstSignal: record.firstSignal,
    lastSignal: record.lastSignal,
    state: record.state,
    rule: record.rule,
    confidence: record.confidence,
  });
}

// ----- Promotion-question idempotency keys -----------------------------------

/**
 * FNV-1a 32-bit hex of a string. Dependency-free (processors stay pure per
 * the processor-purity lint); 8 hex chars is plenty for per-topic rule
 * disambiguation — collisions only re-use an existing question key.
 */
export function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** `dome.agent.preference-promotion:<topic>:<rule-hash>`. */
export function promotionQuestionKey(input: {
  readonly topic: string;
  readonly ruleHash: string;
}): string {
  return `${PREFERENCE_PROMOTION_KEY_PREFIX}${input.topic}:${input.ruleHash}`;
}

/** `dome.agent.preference-demotion:<topic>:<rule-hash>` (the BLOCK's rule). */
export function demotionQuestionKey(input: {
  readonly topic: string;
  readonly ruleHash: string;
}): string {
  return `${PREFERENCE_DEMOTION_KEY_PREFIX}${input.topic}:${input.ruleHash}`;
}

/** Parse a promotion-question key back to its target; null when foreign. */
export function promotionTargetFromKey(
  idempotencyKey: string,
): { readonly topic: string; readonly ruleHash: string } | null {
  return targetFromPrefixedKey(PREFERENCE_PROMOTION_KEY_PREFIX, idempotencyKey);
}

/** Parse a demotion-question key back to its target; null when foreign. */
export function demotionTargetFromKey(
  idempotencyKey: string,
): { readonly topic: string; readonly ruleHash: string } | null {
  return targetFromPrefixedKey(PREFERENCE_DEMOTION_KEY_PREFIX, idempotencyKey);
}

function targetFromPrefixedKey(
  prefix: string,
  idempotencyKey: string,
): { readonly topic: string; readonly ruleHash: string } | null {
  if (!idempotencyKey.startsWith(prefix)) return null;
  const rest = idempotencyKey.slice(prefix.length);
  const match = /^([a-z0-9]+(?:-[a-z0-9]+)*):([0-9a-f]{8})$/.exec(rest);
  if (match === null) return null;
  return Object.freeze({
    topic: match[1] as string,
    ruleHash: match[2] as string,
  });
}

// ----- Tombstones + append validation ----------------------------------------

/** `- YYYY-MM-DD - <topic>:: rejected by owner`. */
export function rejectionTombstoneLine(input: {
  readonly date: string;
  readonly topic: string;
}): string {
  return `- ${input.date} - ${input.topic}:: ${OWNER_REJECTION_RULE}`;
}

/**
 * The rule text of the demotion minus signal. Deliberately NOT the rejection
 * tombstone (`OWNER_REJECTION_RULE`): a demoted topic stays re-promotable —
 * the minus signal records the decay-confirmed removal, and the topic
 * re-earns candidacy if supporting corrections re-accrue.
 */
export const OWNER_DEMOTION_RULE = "demoted by owner (confidence decayed)";

/** `- YYYY-MM-DD - <topic>:: demoted by owner (confidence decayed)`. */
export function demotionSignalLine(input: {
  readonly date: string;
  readonly topic: string;
}): string {
  return `- ${input.date} - ${input.topic}:: ${OWNER_DEMOTION_RULE}`;
}

/**
 * The `keep` answer's fresh plus signal reaffirming the promoted rule
 * verbatim (source suffix omitted — the answer itself is the source).
 * Resetting freshness lifts confidence back above the demotion floor, so
 * `keep` naturally suppresses re-asks.
 */
export function reaffirmationSignalLine(input: {
  readonly date: string;
  readonly topic: string;
  readonly rule: string;
}): string {
  return `- ${input.date} + ${input.topic}:: ${input.rule}`;
}

/** Append a line to the signals page (creates the file content when null). */
export function appendSignalLine(
  content: string | null,
  line: string,
): string {
  if (content === null || content.trim().length === 0) return `${line}\n`;
  return `${content.replace(/\s+$/, "")}\n${line}\n`;
}

/**
 * True when `after` is `before` plus appended lines that are each blank or a
 * well-formed signal line — the brief's splice-guard check for signals-page
 * edits (anything else is dropped as out-of-scope). A null `before` (new
 * file) requires every line of `after` to pass the same rule.
 */
export function isValidSignalsAppend(input: {
  readonly before: string | null;
  readonly after: string;
}): boolean {
  const beforeBody =
    input.before === null ? "" : input.before.replace(/\s+$/, "");
  const afterBody = input.after.replace(/\s+$/, "");
  if (beforeBody.length > 0) {
    if (afterBody === beforeBody) return false; // no-op is not an append
    if (!afterBody.startsWith(`${beforeBody}\n`)) return false;
  }
  const appended = afterBody.slice(
    beforeBody.length === 0 ? 0 : beforeBody.length + 1,
  );
  const lines = appended.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return false;
  return lines.every((line) => {
    const parsed = parsePreferenceSignals(line.trim());
    return parsed.signals.length === 1 && parsed.problems.length === 0;
  });
}
