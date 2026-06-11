// Attention discounting (memory-quality M4) — the shared deterministic core.
//
// Derives, per anchored open-loop item, an implicit dismissal signal from what
// the vault already records: which dailies' generated open-loops blocks showed
// the item (impressions), and when a human last touched its origin file
// (action). The discount is a pure function of the adopted tree + git history
// — the reference "today" is the newest scanned daily's date, NOT the wall
// clock — so `dome.attention.discount` facts are rebuildable by construction
// per [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]].
//
// Normative contract: docs/wiki/specs/task-lifecycle.md §"Attention
// discounting". Formula:
//
//   discount = min(CAP, STEP × max(0, impressionsSinceLastHumanTouch − FREE))
//            × DECAY^daysSinceLastShown
//
// First FREE impressions cost nothing; the value is hard-capped; it decays
// when the item stops being shown (demotion self-heals). Items carrying a due
// date (📅 YYYY-MM-DD) or top priority (🔺) are exempt (discount 0, always).
// Settled items get no entry at all — settling is the cleanup.

import type { Snapshot } from "../../../../src/core/processor";

import { dailyPathSettings, formatDate, parseDailyPath } from "./daily-paths";
import {
  openLoopIdentity,
  openLoopSurfaceKey,
  openLoopSurfaceSources,
  openSourceBackedOpenLoopsFromMarkdown,
  settledSourceBackedOpenLoopsFromMarkdown,
} from "./open-loop-surface";
import type { DailyPathSettings } from "./daily-types";

import { compareStrings } from "../../../../src/core/compare";

export const ATTENTION_DISCOUNT_PREDICATE = "dome.attention.discount";

/** First impressions that cost nothing — surfacing twice is the system doing its job. */
export const ATTENTION_FREE_IMPRESSIONS = 2;
/** Discount added per actionless impression beyond the free ones. */
export const ATTENTION_DISCOUNT_STEP = 0.1;
/** Hard cap — a discount never buries an item outright. */
export const ATTENTION_DISCOUNT_CAP = 0.6;
/** Per-day decay since the item was last shown (LastSeen recovery). */
export const ATTENTION_SHOWN_DECAY_PER_DAY = 0.9;
/** Impression scan bound: only the most recent N dailies are read. */
export const ATTENTION_DAILY_SCAN_LIMIT = 30;
/** Brief threshold: items at/above this discount are "stale loops". */
export const ATTENTION_STALE_THRESHOLD = 0.4;

/**
 * The hourly recency-decay base shared with the ranking consumers. Demotion is
 * multiplicative on the recency score `RECENCY_DECAY_PER_HOUR^hours`, which is
 * order-equivalent to subtracting `log(1−d)/log(base)` hours from the item's
 * last-human-change instant (see {@link attentionAdjustedRecencyMs}).
 */
export const ATTENTION_RECENCY_DECAY_PER_HOUR = 0.995;

export type AttentionDiscount = {
  readonly sourcePath: string;
  readonly body: string;
  readonly line: number;
  readonly stableId: string;
  readonly anchor: string;
  /** Distinct dailies that showed the item dated after the last human touch. */
  readonly impressions: number;
  /** Date (YYYY-MM-DD) of the most recent daily that showed the item. */
  readonly lastShown: string;
  /** newest scanned daily date − lastShown, in whole days (≥ 0). */
  readonly daysSinceLastShown: number;
  /** True when the body carries 📅 YYYY-MM-DD or 🔺 (hard exemption). */
  readonly exempt: boolean;
  readonly discount: number;
};

/** The JSON value shape recorded in a `dome.attention.discount` fact. */
export type AttentionDiscountFactValue = {
  readonly anchor: string;
  readonly body: string;
  readonly discount: number;
  readonly impressions: number;
  readonly lastShown: string;
};

/**
 * The discount formula. Pure; documented in task-lifecycle.md §"Attention
 * discounting". Rounded to 4 decimals so emitted facts are byte-stable.
 */
export function attentionDiscountValue(input: {
  readonly impressions: number;
  readonly daysSinceLastShown: number;
  readonly exempt: boolean;
}): number {
  if (input.exempt) return 0;
  const base = Math.min(
    ATTENTION_DISCOUNT_CAP,
    ATTENTION_DISCOUNT_STEP *
      Math.max(0, input.impressions - ATTENTION_FREE_IMPRESSIONS),
  );
  if (base === 0) return 0;
  const decayed =
    base *
    Math.pow(
      ATTENTION_SHOWN_DECAY_PER_DAY,
      Math.max(0, input.daysSinceLastShown),
    );
  return Math.round(decayed * 10_000) / 10_000;
}

/**
 * True when the item body carries a due date (`📅 YYYY-MM-DD`) or the top
 * priority marker (`🔺`) — the hard discount exemptions. Mirrors the due-date
 * grammar the daily views parse.
 */
export function isAttentionExemptBody(body: string): boolean {
  if (/(?:^|\s)📅\s*\d{4}-\d{2}-\d{2}(?=\s|$)/u.test(body)) return true;
  return body.includes("🔺");
}

/**
 * Demotion as an order-equivalent recency adjustment. Ranking scores recency
 * as `0.995^hoursSince(lastChangedAt)`; multiplying by `(1 − discount)` is the
 * same ordering as moving the change instant `log(1−d)/log(0.995)` hours into
 * the past (≈ 3 days at 0.3, ≈ 7.6 days at the 0.6 cap). Returning a number
 * keeps pairwise comparison transitive without choosing a reference instant.
 * Unparseable/empty timestamps sort last (MIN_SAFE_INTEGER).
 */
export function attentionAdjustedRecencyMs(input: {
  readonly lastChangedAt: string | null | undefined;
  readonly discount: number;
}): number {
  const raw = input.lastChangedAt ?? "";
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return Number.MIN_SAFE_INTEGER;
  const discount = Math.min(Math.max(input.discount, 0), 0.95);
  if (discount === 0) return ts;
  const penaltyHours =
    Math.log(1 - discount) / Math.log(ATTENTION_RECENCY_DECAY_PER_HOUR);
  return ts - penaltyHours * 3_600_000;
}

/**
 * ISO-string form of {@link attentionAdjustedRecencyMs} for call sites that
 * rank by lexicographic timestamp (carry-forward's freshness key). Identity
 * when the discount is 0 so undiscounted behavior is byte-stable.
 */
export function attentionAdjustedRecencyIso(input: {
  readonly lastChangedAt: string;
  readonly discount: number;
}): string {
  if (input.discount <= 0) return input.lastChangedAt;
  const ms = attentionAdjustedRecencyMs(input);
  if (ms === Number.MIN_SAFE_INTEGER) return input.lastChangedAt;
  return new Date(ms).toISOString();
}

type AttentionSnapshot = Pick<
  Snapshot,
  "readFile" | "listMarkdownFiles" | "getFileInfo"
>;

/**
 * Scan the snapshot and derive the discount table, keyed by open-loop identity
 * (`openLoopIdentity` — origin path + normalized body, the same key the daily
 * surface uses). Only items whose origin line carries a `^block-anchor`
 * participate; settled items are excluded; entries exist only for items with
 * at least one counted impression. Deterministic per snapshot: no clock.
 */
export async function collectAttentionDiscounts(input: {
  readonly snapshot: AttentionSnapshot;
  readonly settings?: DailyPathSettings;
  readonly config?: Readonly<Record<string, unknown>>;
}): Promise<ReadonlyMap<string, AttentionDiscount>> {
  const settings = input.settings ?? dailyPathSettings(input.config);
  const paths = await input.snapshot.listMarkdownFiles();
  const contents = new Map<string, string>();
  for (const path of paths) {
    const content = await input.snapshot.readFile(path);
    if (content !== null) contents.set(path, content);
  }

  // The most recent dailies, newest first. The newest daily's date is the
  // deterministic reference "today".
  const dailies = [...contents.keys()]
    .map((path) => {
      const date = parseDailyPath(path, settings);
      return date === null ? null : { path, date: formatDate(date) };
    })
    .filter((entry): entry is { path: string; date: string } => entry !== null)
    .sort((a, b) => compareStrings(b.date, a.date))
    .slice(0, ATTENTION_DAILY_SCAN_LIMIT);
  const referenceDate = dailies[0]?.date;
  if (referenceDate === undefined) return new Map();

  // Impressions: distinct daily dates whose generated open-loops block carries
  // an OPEN copy of the item, keyed by open-loop identity.
  const shownDates = new Map<string, Set<string>>();
  for (const daily of dailies) {
    const content = contents.get(daily.path);
    if (content === undefined) continue;
    for (const item of openSourceBackedOpenLoopsFromMarkdown({
      path: daily.path,
      content,
    })) {
      const key = openLoopIdentity(item);
      const dates = shownDates.get(key) ?? new Set<string>();
      dates.add(daily.date);
      shownDates.set(key, dates);
    }
  }
  if (shownDates.size === 0) return new Map();

  // Settled anywhere → no entry (cleanup). Same key set carry-forward uses.
  const settledIdentities = new Set<string>();
  const settledSurfaceKeys = new Set<string>();
  for (const [path, content] of contents) {
    for (const item of settledSourceBackedOpenLoopsFromMarkdown({
      path,
      content,
    })) {
      settledIdentities.add(openLoopIdentity(item));
      settledSurfaceKeys.add(openLoopSurfaceKey(item));
    }
  }

  const lastHumanDateByPath = new Map<string, string | null>();
  const out = new Map<string, AttentionDiscount>();
  for (const [path, content] of contents) {
    for (const item of openLoopSurfaceSources({ path, content, settings })) {
      if (item.anchor === undefined) continue;
      const identity = openLoopIdentity(item);
      if (out.has(identity)) continue;
      if (
        settledIdentities.has(identity) ||
        settledSurfaceKeys.has(openLoopSurfaceKey(item))
      ) {
        continue;
      }
      const dates = shownDates.get(identity);
      if (dates === undefined || dates.size === 0) continue;

      if (!lastHumanDateByPath.has(path)) {
        const info = await input.snapshot.getFileInfo(path);
        lastHumanDateByPath.set(
          path,
          info?.lastHumanChangedAt?.slice(0, 10) ?? null,
        );
      }
      const lastHumanDate = lastHumanDateByPath.get(path) ?? null;

      // Only dailies dated strictly AFTER the last human touch count — any
      // human edit to the origin file resets the impression trail.
      const counted = [...dates].filter(
        (date) => lastHumanDate === null || date > lastHumanDate,
      );
      if (counted.length === 0) continue;
      const lastShown = [...dates].sort().at(-1) ?? referenceDate;
      const daysSinceLastShown = wholeDaysBetween(lastShown, referenceDate);
      const exempt = isAttentionExemptBody(item.body);
      out.set(
        identity,
        Object.freeze({
          sourcePath: path,
          body: item.body,
          line: item.line,
          stableId: item.stableId,
          anchor: item.anchor,
          impressions: counted.length,
          lastShown,
          daysSinceLastShown,
          exempt,
          discount: attentionDiscountValue({
            impressions: counted.length,
            daysSinceLastShown,
            exempt,
          }),
        }),
      );
    }
  }
  return out;
}

/** Encode the fact value (stable key order — facts must be byte-stable). */
export function attentionDiscountFactValue(
  entry: AttentionDiscount,
): string {
  const value: AttentionDiscountFactValue = {
    anchor: entry.anchor,
    body: entry.body,
    discount: entry.discount,
    impressions: entry.impressions,
    lastShown: entry.lastShown,
  };
  return JSON.stringify(value);
}

/** Decode a fact value; null when the JSON is not the expected shape. */
export function parseAttentionDiscountFactValue(
  raw: string,
): AttentionDiscountFactValue | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.anchor !== "string") return null;
  if (typeof record.body !== "string") return null;
  if (typeof record.discount !== "number") return null;
  if (typeof record.impressions !== "number") return null;
  if (typeof record.lastShown !== "string") return null;
  return Object.freeze({
    anchor: record.anchor,
    body: record.body,
    discount: record.discount,
    impressions: record.impressions,
    lastShown: record.lastShown,
  });
}

/** Whole days from `from` to `to` (both YYYY-MM-DD), clamped at 0. */
function wholeDaysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return 0;
  return Math.max(0, Math.round((toMs - fromMs) / 86_400_000));
}
