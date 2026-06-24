import { generatedBlockMarkers } from "../../../../src/core/generated-block";

const DEFAULT_DAILY_PATH_TEMPLATE = "wiki/dailies/{date}.md";

// dome.daily's generated blocks, rendered from the core grammar primitive —
// the only sanctioned marker implementation (see
// [[wiki/linters/generated-block-splice-guard]]).
// internal — not public API; exported for use by other daily-* modules
export const DAILY_OWNER = "dome.daily";
// Retired-legacy (recognized, never written) — see
// [[wiki/specs/daily-surface]] §"Block ownership".
// internal — not public API; exported for use by other daily-* modules
export const CARRIED_FORWARD_BLOCK = "carried-forward";
// Retired-legacy since D2 (recognized, never written): the mechanical
// yesterday digest now lives as the fallback BODY of the unified
// dome.agent.brief:yesterday block. See
// [[wiki/specs/daily-surface]] §"The one yesterday block".
// internal — not public API; exported for use by other daily-* modules
export const START_CONTEXT_BLOCK = "start-context";
// internal — not public API; exported for use by other daily-* modules
export const OPEN_LOOPS_BLOCK = "open-loops";
// internal — not public API; exported for use by other daily-* modules
export const CAPTURED_BLOCK = "captured";
// The evening close scaffold (D4): done candidates + still-open line-up +
// story pointer under ## Done, written by dome.daily.close-scaffold ONLY when
// absent (presence-gated — human keep/delete edits are never rewritten).
// Normative at [[wiki/specs/daily-surface]] §"The close block".
// internal — not public API; exported for use by other daily-* modules
export const CLOSE_BLOCK = "close";

// The unified yesterday block (D2): owned by the brief's namespace — the
// edition compile is its steady-state writer — but its `(owner, block)`
// identity is defined HERE so dome.agent imports it from dome.daily (the
// established bundle dependency direction) and the marker strings cannot
// drift apart. dome.daily's create-daily/carry-forward seed the mechanical
// fallback body only when the block is absent; the brief replaces the body
// wholesale. The one recorded exception to disjoint block ownership —
// normative at [[wiki/specs/daily-surface]] §"The one yesterday block".
// internal — not public API; exported for use by other daily-* modules
export const EDITION_YESTERDAY_OWNER = "dome.agent.brief";
// internal — not public API; exported for use by other daily-* modules
export const EDITION_YESTERDAY_BLOCK_NAME = "yesterday";
const EDITION_YESTERDAY_MARKERS = generatedBlockMarkers(
  EDITION_YESTERDAY_OWNER,
  EDITION_YESTERDAY_BLOCK_NAME,
);

export const EDITION_YESTERDAY_BLOCK: {
  readonly owner: string;
  readonly block: string;
  readonly start: string;
  readonly end: string;
} = Object.freeze({
  owner: EDITION_YESTERDAY_OWNER,
  block: EDITION_YESTERDAY_BLOCK_NAME,
  start: EDITION_YESTERDAY_MARKERS.start,
  end: EDITION_YESTERDAY_MARKERS.end,
});

// internal — not public API; exported for use by other daily-* modules
export const CARRIED_FORWARD_MARKERS = generatedBlockMarkers(
  DAILY_OWNER,
  CARRIED_FORWARD_BLOCK,
);
// internal — not public API; exported for use by other daily-* modules
export const START_CONTEXT_MARKERS = generatedBlockMarkers(
  DAILY_OWNER,
  START_CONTEXT_BLOCK,
);
// internal — not public API; exported for use by other daily-* modules
export const OPEN_LOOPS_MARKERS = generatedBlockMarkers(
  DAILY_OWNER,
  OPEN_LOOPS_BLOCK,
);
// internal — not public API; exported for use by other daily-* modules
export const CAPTURED_MARKERS = generatedBlockMarkers(
  DAILY_OWNER,
  CAPTURED_BLOCK,
);
// internal — not public API; exported for use by other daily-* modules
export const CLOSE_MARKERS = generatedBlockMarkers(DAILY_OWNER, CLOSE_BLOCK);

export const CARRIED_FORWARD_START = CARRIED_FORWARD_MARKERS.start;
export const CARRIED_FORWARD_END = CARRIED_FORWARD_MARKERS.end;
export const START_CONTEXT_START = START_CONTEXT_MARKERS.start;
export const START_CONTEXT_END = START_CONTEXT_MARKERS.end;
export const OPEN_LOOPS_START = OPEN_LOOPS_MARKERS.start;
export const OPEN_LOOPS_END = OPEN_LOOPS_MARKERS.end;
export const CAPTURED_START = CAPTURED_MARKERS.start;
export const CAPTURED_END = CAPTURED_MARKERS.end;

export const CAPTURED_HEADING = "## Captured today";

/**
 * The one-line hint the skeleton renders inside the (otherwise empty)
 * captured block. A plain HTML comment — not a dome marker — invisible in
 * preview and skipped by every extractor.
 */
// internal — not public API; exported for use by other daily-* modules
export const CAPTURED_HINT =
  "<!-- tasks captured during the day land here (`dome capture` -> ingest) -->";
export const CLOSE_START = CLOSE_MARKERS.start;
export const CLOSE_END = CLOSE_MARKERS.end;

/**
 * The generated blocks a daily note may carry, as `(owner, block)`
 * anomaly-scan targets — what splice call sites feed
 * `generatedBlockAnomalyDiagnostics` so smuggled duplicate pairs / half-open
 * markers in a daily note surface as info diagnostics instead of staying
 * invisible. Includes the retired-legacy markers (recognized, never written:
 * legacy blocks must neither re-ingest as tasks nor hide marker damage) and
 * the dual-writer `dome.agent.brief:yesterday` block (carry-forward splices
 * it, so it reports what it sees at its own splice site; the brief scans the
 * same block under its own code).
 *
 * NOTE: this is the ANOMALY-SCAN list, not the task-extraction exclusion
 * list. `dome.daily:captured` is scanned for marker anomalies like every
 * other block, but its body is deliberately NOT excluded from extraction —
 * captured tasks are origins, not copies (see
 * `dailyGeneratedBlockLineRanges` and [[wiki/specs/daily-surface]] §"The
 * `captured` block holds origins, not copies").
 */
export const DAILY_GENERATED_BLOCKS: ReadonlyArray<{
  readonly owner: string;
  readonly block: string;
}> = Object.freeze([
  Object.freeze({ owner: DAILY_OWNER, block: START_CONTEXT_BLOCK }),
  Object.freeze({ owner: DAILY_OWNER, block: OPEN_LOOPS_BLOCK }),
  Object.freeze({ owner: DAILY_OWNER, block: CARRIED_FORWARD_BLOCK }),
  Object.freeze({ owner: DAILY_OWNER, block: CLOSE_BLOCK }),
  Object.freeze({
    owner: EDITION_YESTERDAY_OWNER,
    block: EDITION_YESTERDAY_BLOCK_NAME,
  }),
  Object.freeze({ owner: DAILY_OWNER, block: CAPTURED_BLOCK }),
]);

export type DailyDate = {
  readonly yyyy: string;
  readonly mm: string;
  readonly dd: string;
};

export type DailyPathSettings = {
  readonly template: string;
};

export type OpenTask = {
  readonly line: number;
  readonly text: string;
  readonly sourcePath: string | null;
  readonly body: string;
  readonly followup: boolean;
  /** The stamped `^block-anchor` id, if the line carries one. */
  readonly anchor?: string;
  /** The decoded URL/path from an inline `([↗](target))` marker, if present. */
  readonly origin?: string;
};

export type MarkdownActionItem = {
  readonly line: number;
  readonly text: string;
  readonly body: string;
  readonly followup: boolean;
  /** Discriminates checkbox tasks from directive (`todo:`/`follow-up:`) items. */
  readonly kind: "checkbox" | "directive";
  /** The decoded URL/path from an inline `([↗](target))` marker, if present. */
  readonly origin?: string;
  /** The stamped `^block-anchor` id, if the line carries one. */
  readonly anchor?: string;
};

export type AmbiguousFollowup = {
  readonly line: number;
  readonly text: string;
};

export type DailyOpenLoopSource = {
  readonly line: number;
  readonly stableId: string;
  readonly body: string;
  readonly followup: boolean;
  readonly sourcePath: string;
  /** The origin line's stamped `^block-anchor` id, when it carries one. */
  readonly anchor?: string;
  /** Decoded URL/path from an inline `([↗](target))` origin marker, if present. */
  readonly origin?: string;
};

export type DailyOpenLoopCandidate = DailyOpenLoopSource & {
  readonly lastChangedAt: string;
};

export type DailySettledOpenLoopSource = {
  readonly line: number;
  readonly stableId: string;
  readonly path: string;
  readonly body: string;
  readonly followup: boolean;
  readonly sourcePath: string;
  readonly status: DailyOpenLoopSettlementStatus;
  /** The origin line's stamped `^block-anchor` id, when the copy carries one. */
  readonly anchor?: string;
};

export type PreviousDailyDigest = {
  readonly previousPath: string;
  readonly done: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
  readonly story: string | null;
  /**
   * The previous daily's close digest (D4); null when no `dome.daily:close`
   * block exists (close skipped, or a pre-D4 daily). When present, `done`
   * above is the close's kept candidates — raw `## Done` section scraping is
   * skipped because the close is the authoritative done record.
   * Normative at [[wiki/specs/daily-surface]] §"The close block".
   */
  readonly close: DailyCloseDigest | null;
};

/** What tomorrow's mechanical yesterday fallback reads out of a close block. */
export type DailyCloseDigest = {
  /** Bullets the human kept under `### Done today` (cleaned; may be empty). */
  readonly kept: ReadonlyArray<string>;
  /** Parsed `### Still open` count; null when missing or unparseable. */
  readonly stillOpenCount: number | null;
};

/** A done candidate rendered into the close scaffold's `### Done today`. */
export type DailyCloseDoneCandidate = {
  /** 1-based line of the settled line in today's daily (sourceRef anchor). */
  readonly line: number;
  readonly body: string;
  readonly status: DailyOpenLoopSettlementStatus;
  /** Origin file for source-backed copies; null when settled directly in today's daily. */
  readonly originPath: string | null;
};

/** A settled `[x]`/`[-]` checkbox line authored directly in a note (no `(from [[…]])` suffix). */
export type SettledActionItem = {
  readonly line: number;
  readonly body: string;
  readonly status: DailyOpenLoopSettlementStatus;
};

export type DailyOpenLoopSettlementStatus = "resolved" | "dismissed";

// internal — not public API; exported for use by other daily-* modules
export const DEFAULT_DAILY_PATH_SETTINGS: DailyPathSettings = Object.freeze({
  template: DEFAULT_DAILY_PATH_TEMPLATE,
});

// internal — not public API; exported for use by other daily-* modules
export const CARRY_FORWARD_RE =
  /\s+\(from \[\[([^\]\n]*\d{4}-\d{2}-\d{2})(?:\.md)?\]\]\)\s*$/;
