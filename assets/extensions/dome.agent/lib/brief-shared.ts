// dome.agent.brief — deterministic plumbing for the morning brief.
//
// Marker-delimited generated blocks (same pattern as dome.daily's
// start-context / open-loops / carried-forward blocks), defensive calendar
// and slack parsing, the grounding splice that keeps model output inside its
// own blocks, and the compose-record fingerprint gate — the deterministic
// record every successful compose writes and the pre-pass reads to decide
// whether current inputs warrant a re-compose. Everything here is pure
// string/data work — the LLM never touches these seams.

import {
  findGeneratedBlock,
  generatedBlockMarkers,
  replaceGeneratedBlock,
  sanitizeGeneratedBlockBody,
  extractGeneratedBlockBody as extractGeneratedBlockBodyCore,
} from "../../../../src/core/generated-block";
import { EDITION_YESTERDAY_BLOCK } from "../../dome.daily/processors/daily-types";

// Calendar parsing moved to dome.daily/processors/calendar-day.ts — the
// sanctioned cross-bundle import direction (dome.agent -> dome.daily) means
// this shared pure grammar lives there so dome.daily's own compose-blocks
// processor can read it too. Re-exported here so existing dome.agent
// importers (e.g. calendar-index.ts) keep working unchanged.
export {
  parseCalendarDay,
  type CalendarMeeting,
} from "../../dome.daily/processors/calendar-day";

/** The brief's marker-block owner namespace. */
const BRIEF_OWNER = "dome.agent.brief";

/**
 * A brief block's identity: the `(owner, block)` pair plus the rendered
 * markers from the `src/core/generated-block` grammar primitive — the only
 * sanctioned marker implementation (see
 * [[wiki/linters/generated-block-splice-guard]]).
 */
export type BriefBlockMarkers = {
  readonly owner: string;
  readonly block: string;
  readonly start: string;
  readonly end: string;
};

function briefBlock(block: string): BriefBlockMarkers {
  return Object.freeze({
    owner: BRIEF_OWNER,
    block,
    ...generatedBlockMarkers(BRIEF_OWNER, block),
  });
}

// The unified yesterday block (D2): its `(owner, block)` identity is defined
// once in dome.daily's daily-shared.ts (the daily-note block table) so the
// dual writers — the brief's wholesale replace and dome.daily's
// presence-gated fallback seed — can never drift apart. See
// [[wiki/specs/daily-surface]] §"The one yesterday block".
export const YESTERDAY_BLOCK: BriefBlockMarkers = Object.freeze({
  owner: EDITION_YESTERDAY_BLOCK.owner,
  block: EDITION_YESTERDAY_BLOCK.block,
  start: EDITION_YESTERDAY_BLOCK.start,
  end: EDITION_YESTERDAY_BLOCK.end,
});
export const TODAY_BLOCK: BriefBlockMarkers = briefBlock("today");
export const MEETINGS_BLOCK: BriefBlockMarkers = briefBlock("meetings");
export const COMPOSE_RECORD_BLOCK: BriefBlockMarkers = briefBlock("compose-record");

// Retired-legacy blocks (D-compose-blocks): the questions / integrated /
// sources blocks left the brief's charter for dome.daily.compose-blocks
// ([[wiki/specs/daily-surface]] §"Block ownership"). The brief no longer
// WRITES them, but its anomaly scan still RECOGNIZES their markers so a
// stray hand-edited or smuggled pair still surfaces as an anomaly
// diagnostic; compose-blocks owns removing the live blocks it now writes.
export const QUESTIONS_BLOCK: BriefBlockMarkers = briefBlock("questions");
export const INTEGRATED_BLOCK: BriefBlockMarkers = briefBlock("integrated");
export const SOURCES_BLOCK: BriefBlockMarkers = briefBlock("sources");

// ----- Slack digest parsing (defensive — the file is untrusted input) --------

export type SlackDigestEntry = {
  readonly channel: string | null;
  readonly time: string | null;
  readonly text: string;
  readonly permalink?: string;
};

export type SlackDigest = {
  readonly mentions: ReadonlyArray<SlackDigestEntry>;
  readonly dms: ReadonlyArray<SlackDigestEntry>;
  readonly channels: ReadonlyArray<SlackDigestEntry>;
};

const MAX_SLACK_ITEMS_PER_SECTION = 15;
const MAX_SLACK_TEXT_CHARS = 240;

/**
 * Parse a `sources/slack/YYYY-MM-DD.md` file per the vault-layout slack-day
 * shape: optional frontmatter, three optional `## Mentions` /
 * `## Direct messages` / `## Channels` sections, entries as top-level `- `
 * items with an optional `[#channel]`/`[DM]` prefix and optional `HH:MM`
 * time. Defensive by contract — mirrors `parseCalendarDay`: frontmatter and
 * unknown headings are skipped, items outside a known section are dropped,
 * unparseable items degrade to text-only entries, counts and text lengths
 * are capped, and the output is data for a prompt, never instructions.
 */
export function parseSlackDigest(content: string): SlackDigest {
  const mentions: SlackDigestEntry[] = [];
  const dms: SlackDigestEntry[] = [];
  const channels: SlackDigestEntry[] = [];
  const sections: Record<string, SlackDigestEntry[]> = {
    mentions,
    "direct messages": dms,
    channels,
  };
  let current: SlackDigestEntry[] | null = null;
  const lines = content.split(/\r?\n/);
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (i === 0 && line.trim() === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === "---") inFrontmatter = false;
      continue;
    }
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      current = sections[(heading[1] ?? "").toLowerCase()] ?? null;
      continue;
    }
    if (current === null || current.length >= MAX_SLACK_ITEMS_PER_SECTION) {
      continue;
    }
    const item = /^\s*[-*]\s+(\S.*)$/.exec(line);
    if (item === null) continue;
    const entry = parseSlackEntryLine(item[1] ?? "");
    if (entry !== null) current.push(entry);
  }
  return Object.freeze({
    mentions: Object.freeze(mentions),
    dms: Object.freeze(dms),
    channels: Object.freeze(channels),
  });
}

function parseSlackEntryLine(raw: string): SlackDigestEntry | null {
  let rest = raw.trim();
  if (rest.length === 0) return null;

  let channel: string | null = null;
  const channelMatch = /^\[([^\]]+)\]\s*(.*)$/.exec(rest);
  if (
    channelMatch !== null &&
    (channelMatch[1] ?? "").trim().length > 0 &&
    (channelMatch[2] ?? "").trim().length > 0
  ) {
    channel = (channelMatch[1] ?? "").trim();
    rest = (channelMatch[2] ?? "").trim();
  }

  let time: string | null = null;
  const timeMatch = /^(\d{1,2}:\d{2})\s+(.*)$/.exec(rest);
  if (timeMatch !== null && (timeMatch[2] ?? "").trim().length > 0) {
    time = timeMatch[1] ?? null;
    rest = (timeMatch[2] ?? "").trim();
  }

  if (rest.length === 0) return null;

  // Extract optional trailing permalink autolink <https://…> before capping text.
  let permalink: string | undefined;
  const permalinkMatch = /\s*<(https?:\/\/[^>\s]+)>\s*$/.exec(rest);
  if (permalinkMatch !== null) {
    permalink = permalinkMatch[1];
    rest = rest.slice(0, permalinkMatch.index).trim();
  }

  const text =
    rest.length > MAX_SLACK_TEXT_CHARS
      ? `${rest.slice(0, MAX_SLACK_TEXT_CHARS - 1)}…`
      : rest;
  return Object.freeze(
    permalink !== undefined
      ? { channel, time, text, permalink }
      : { channel, time, text },
  );
}

// ----- Block plumbing --------------------------------------------------------
//
// Bounding is delegated to the line-anchored scanner in
// `src/core/generated-block` — a marker counts only when the entire trimmed
// line is the marker, so prose/fence mentions and mid-line smuggles never
// bound a block. Placement (which heading a missing block is inserted under)
// stays here: the primitive owns bounding, not placement.

/** The text between the markers (exclusive), or null when the block is absent. */
export function extractBriefBlockBody(
  content: string,
  markers: BriefBlockMarkers,
): string | null {
  return extractGeneratedBlockBodyCore(content, markers.owner, markers.block);
}

/**
 * Replace an existing marker block with `section` (a full block including
 * markers), or insert it. Insertion goes directly under `## <heading>` when
 * the heading exists; otherwise the heading + section are appended at the
 * end. `section: null` removes an existing block (used to drop a stale
 * questions block when all questions are resolved).
 */
export function replaceBriefBlock(input: {
  readonly content: string;
  readonly markers: BriefBlockMarkers;
  readonly section: string | null;
  readonly heading: string;
  /**
   * Insert after this block when present (e.g. meetings prose after the
   * deterministic `dome.daily:agenda` block, compose-record after the last
   * Start-Here block). Only the `(owner, block)` identity is consulted, so a
   * cross-bundle `dome.daily:*` identity works as an anchor too.
   */
  readonly afterBlock?: { readonly owner: string; readonly block: string };
}): string {
  const replaced = replaceGeneratedBlock(
    input.content,
    input.markers.owner,
    input.markers.block,
    input.section === null ? "" : input.section,
  );
  if (replaced !== null) return replaced;
  if (input.section === null) return input.content;

  if (input.afterBlock !== undefined) {
    const anchor = findGeneratedBlock(
      input.content,
      input.afterBlock.owner,
      input.afterBlock.block,
    ).range;
    if (anchor !== null) {
      return `${input.content.slice(0, anchor.end)}\n\n${input.section}${input.content.slice(anchor.end)}`;
    }
  }

  const heading = new RegExp(
    `^## ${escapeRegExp(input.heading)}[ \\t]*$`,
    "m",
  ).exec(input.content);
  if (heading !== null && heading.index !== undefined) {
    const insertAt = heading.index + heading[0].length;
    const rest = input.content.slice(insertAt).replace(/^(?:\r?\n)*/, "\n\n");
    return `${input.content.slice(0, insertAt)}\n\n${input.section}${rest}`;
  }

  const suffix = input.content.endsWith("\n") ? "" : "\n";
  return `${input.content}${suffix}\n## ${input.heading}\n\n${input.section}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ----- Grounding splice ------------------------------------------------------

export type GroundedBlockBody = {
  readonly kept: string;
  readonly ungrounded: ReadonlyArray<string>;
};

/** Backtick code spans don't ground a bullet — `[[x]]` in code is not a link. */
function stripCodeSpans(line: string): string {
  return line.replace(/`[^`]*`/g, "");
}

/**
 * Enforce the grounding rule on a model-written block body: every bullet
 * line must carry at least one `[[wikilink]]` source ref (code spans are
 * stripped first, so a backticked `[[x]]` does not count). Ungrounded
 * bullets are stripped from the body and returned separately so the caller
 * can re-emit each as a QuestionEffect — ungrounded content becomes a
 * question, not brief text. Non-bullet lines (headings, blanks) pass
 * through.
 *
 * Marker-injection guard: the body is sanitized first via
 * `sanitizeGeneratedBlockBody` — lines carrying a `<!-- dome…` marker
 * comment are dropped entirely and stray bare `<!--`/`-->` fragments are
 * stripped. Dome's HTML comments are exclusively generated block markers, so
 * no legitimate model-written body line ever carries one; a body that
 * smuggles marker lines could fabricate a second copy of another block
 * (`replaceBriefBlock` replaces only the first occurrence, so the smuggled
 * copy would survive the deterministic pass verbatim) or corrupt
 * `dome.daily`'s carry-forward regions — and calendar files are untrusted
 * input that flows into the model, so this is a live prompt-injection path.
 */
export function groundBriefBlockBody(body: string): GroundedBlockBody {
  const sanitized = sanitizeGeneratedBlockBody(body);
  const kept: string[] = [];
  const ungrounded: string[] = [];
  for (const line of sanitized.body.split("\n")) {
    const isBullet = /^\s*[-*]\s+\S/.test(line);
    if (isBullet && !stripCodeSpans(line).includes("[[")) {
      ungrounded.push(line.trim());
      continue;
    }
    kept.push(line);
  }
  return Object.freeze({
    kept: kept.join("\n"),
    ungrounded: Object.freeze(ungrounded),
  });
}

// ----- Compose-record fingerprint gate (deterministic) ------------------------
//
// The wake-tick choreography gate's entire state ([[wiki/specs/daily-surface]]
// §"Wake-tick choreography", [[wiki/specs/autonomous-agents]]
// §"The compose-record gate"). A wake-tick burst can fire the brief in the
// same tick as dome.daily.compose-blocks and the calendar/slack fetch
// dispatch, but the fetch completes asynchronously (outbox → command →
// commit → adoption), so a wake-tick brief can compose before its inputs are
// final. The brief runs on every fire (cron + the file.created signals on the
// source day-files) a deterministic, model-free pre-pass: it hashes the
// current material inputs and compares each against the recorded hashes.
//
// Content hashes, not presence flags, carry the state: the meetings block's
// presence is a dishonest proxy (a present-but-empty calendar legitimately
// renders no meetings block) and the Slack digest leaves no mechanical
// footprint at all. All-match is a zero-model, zero-effect no-op; any
// mismatch re-composes all three narrative blocks and rewrites the record
// with fresh hashes and an incremented count. Re-composes are capped at
// MAX_DAILY_COMPOSES model composes per day. The failure-stub path
// deliberately never writes this record — a failed brief's recovery stays
// with its acknowledgeable question, never an automatic signal-triggered
// retry, so a parseable record means the brief has SUCCESSFULLY composed
// today.

/** The per-day cap on model composes; beyond it the narrative freezes for the day. */
export const MAX_DAILY_COMPOSES = 3;

export type BriefComposeRecord = {
  /** Today's model-compose count so far (1-based; rendered `1×`, `2×`, …). */
  readonly count: number;
  /** "HH:MM" vault-local, from ctx.now(). */
  readonly time: string;
  /**
   * Per-input 8-hex FNV-1a content fingerprints of the material inputs at the
   * last successful compose, or "—" when that input was absent.
   */
  readonly inputs: {
    readonly calendar: string;
    readonly slack: string;
    readonly yesterday: string;
  };
};

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Pure FNV-1a 32-bit → 8-hex content fingerprint; "—" for a null/absent
 * input. Hand-written (never Bun.hash) so the processor stays import-pure
 * (the processor-purity fence forbids `bun` imports). Operates over UTF-16
 * code units — canonical byte semantics are irrelevant here; the only
 * contract is a stable, deterministic hash for equality comparison of Dome's
 * own content.
 */
export function inputFingerprint(content: string | null): string {
  if (content === null) return "—";
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Render the compose-record generated block: one italic line recording the
 * compose count, vault-local time, and the per-input fingerprints. The
 * grammar round-trips through parseBriefComposeRecord verbatim.
 */
export function composeRecordSection(record: BriefComposeRecord): string {
  const line =
    `_Composed ${record.count}× ${record.time}` +
    ` · calendar@${record.inputs.calendar}` +
    ` · slack@${record.inputs.slack}` +
    ` · yesterday@${record.inputs.yesterday}_`;
  return [COMPOSE_RECORD_BLOCK.start, line, COMPOSE_RECORD_BLOCK.end].join("\n");
}

const COMPOSE_RECORD_RE =
  /_Composed (\d+)× (\d{2}:\d{2}) · calendar@([0-9a-f]{8}|—) · slack@([0-9a-f]{8}|—) · yesterday@([0-9a-f]{8}|—)_/;

/**
 * Parse the compose-record out of a daily note. `null` when the block is
 * absent or unparseable — both mean "no successful compose recorded today",
 * which the gate treats as first-compose-not-done (corruption never triggers
 * a signal-driven model run).
 */
export function parseBriefComposeRecord(
  content: string,
): BriefComposeRecord | null {
  const body = extractBriefBlockBody(content, COMPOSE_RECORD_BLOCK);
  if (body === null) return null;
  const match = COMPOSE_RECORD_RE.exec(body);
  if (match === null) return null;
  const count = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(count)) return null;
  return Object.freeze({
    count,
    time: match[2] ?? "",
    inputs: Object.freeze({
      calendar: match[3] ?? "",
      slack: match[4] ?? "",
      yesterday: match[5] ?? "",
    }),
  });
}
