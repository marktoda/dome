// daily-scaffold.ts — skeleton/close/yesterday rendering.

import {
  findGeneratedBlock,
} from "../../../../src/core/generated-block";

import {
  DAILY_OWNER,
  CLOSE_BLOCK,
  START_CONTEXT_BLOCK,
  CAPTURED_HINT,
  CAPTURED_HEADING,
  CAPTURED_START,
  CAPTURED_END,
  CLOSE_START,
  CLOSE_END,
  EDITION_YESTERDAY_BLOCK,
  DEFAULT_DAILY_PATH_SETTINGS,
  type DailyDate,
  type DailyPathSettings,
  type PreviousDailyDigest,
  type DailyCloseDigest,
  type DailyCloseDoneCandidate,
  type DailyOpenLoopSource,
} from "./daily-types";

import {
  escapeRegExp,
  formatDate,
  dailyLink,
} from "./daily-paths";

import {
  dailyBlockRange,
  dailyBlockRangeFor,
  endOfHeadingSection,
} from "./open-loop-surface";

export function renderDailySkeleton(input: {
  readonly today: DailyDate;
  readonly yesterday: DailyDate | null;
  readonly settings?: DailyPathSettings;
}): string {
  const today = formatDate(input.today);
  const settings = input.settings ?? DEFAULT_DAILY_PATH_SETTINGS;
  const lines: string[] = [
    "---",
    "type: daily",
    `created: ${today}`,
    `updated: ${today}`,
    `recurrence: "${today}"`,
  ];
  if (input.yesterday !== null) {
    lines.push(`prev: "[[${dailyLink(input.yesterday, settings)}]]"`);
  }
  lines.push(
    "---",
    "",
    `# ${today}`,
    "",
    // Captured today is the FIRST content section (the real-vault
    // convention the daily-surface section contract formalizes): the live
    // capture landing zone, with the owned block rendered empty so the
    // ingest tool seam always has a region to splice into.
    CAPTURED_HEADING,
    "",
    CAPTURED_START,
    CAPTURED_HINT,
    CAPTURED_END,
    "",
    "## Start Here",
    "",
    "## Meetings",
    "",
    "## Open Loops",
    "",
    "## Notes",
    "",
    "## Decisions",
    "",
    "## Done",
    "",
    "## Story of the Day",
    "",
  );
  return lines.join("\n");
}

export function previousDailyDigest(input: {
  readonly previousPath: string;
  readonly previousContent: string;
}): PreviousDailyDigest {
  // Prefer the close block (D4): when the previous daily carries a
  // dome.daily:close block, its kept candidates ARE the done record and the
  // raw ## Done section scrape is skipped (the block lives under ## Done, so
  // scraping would also re-ingest its hint lines). Absent block → scraping,
  // exactly the pre-D4 behavior. Decisions/Story scraping is unaffected in
  // both cases — the close does not own those sections.
  const close = closeDigestFromDailyContent(input.previousContent);
  return Object.freeze({
    previousPath: input.previousPath,
    done:
      close === null
        ? extractSectionItems(input.previousContent, "Done")
        : close.kept,
    decisions: extractSectionItems(input.previousContent, "Decisions"),
    story: extractStorySummary(input.previousContent),
    close,
  });
}

/**
 * Render the mechanical fallback body of the unified yesterday block
 * (`dome.agent.brief:yesterday`) — the no-model rung of the edition's
 * degradation ladder. One block, one heading (`### Yesterday`), plain
 * bullets only. `digest: null` (no previous daily) degrades to a single
 * "no record of yesterday" line, never an absent block.
 * Normative at [[wiki/specs/daily-surface]] §"The one yesterday block".
 */
export function yesterdayFallbackSection(
  digest: PreviousDailyDigest | null,
): string {
  const lines = [EDITION_YESTERDAY_BLOCK.start, "### Yesterday"];
  if (digest === null) {
    lines.push("- No record of yesterday — no previous daily note.");
  } else {
    lines.push(
      `- Previous daily: [[${digest.previousPath.replace(/\.md$/, "")}]]`,
    );
    if (digest.close !== null && digest.done.length === 0) {
      // The close ran but holds zero kept candidates (written empty, or the
      // human deleted every one): explicit, visible degradation — never
      // silent thinness. Daily-surface §"The close block".
      lines.push("- Yesterday's close was empty.");
    } else if (digest.done.length > 0) {
      lines.push(`- Done yesterday: ${renderCompactList(digest.done)}`);
    }
    if (digest.close !== null && digest.close.stillOpenCount !== null) {
      const count = digest.close.stillOpenCount;
      lines.push(
        `- Still open at close: ${count} ${count === 1 ? "loop" : "loops"} carried.`,
      );
    }
    if (digest.decisions.length > 0) {
      lines.push(
        `- Decisions yesterday: ${renderCompactList(digest.decisions)}`,
      );
    }
    if (digest.story !== null) {
      lines.push(`- Story: ${digest.story}`);
    }
  }
  lines.push(EDITION_YESTERDAY_BLOCK.end);
  return lines.join("\n");
}

/**
 * Ensure the unified yesterday block exists: insert `section` (a full
 * fallback block including markers) when the block is absent, and leave an
 * existing block — curated or previously seeded — alone ENTIRELY. The
 * presence gate is what makes dome.daily's write into the brief's namespace
 * safe (the dual-writer exception, daily-surface §"The one yesterday block").
 */
export function ensureYesterdayFallbackSection(input: {
  readonly content: string;
  readonly section: string;
}): string {
  const existing = dailyBlockRangeFor(
    input.content,
    EDITION_YESTERDAY_BLOCK.owner,
    EDITION_YESTERDAY_BLOCK.block,
  );
  if (existing !== null) return input.content;
  return insertYesterdayFallbackSection({
    content: input.content,
    section: input.section,
  });
}

/**
 * One-time migration for the retired `dome.daily:start-context` block:
 * remove it (markers and body) from the given daily content, tidying the
 * seam to at most one blank line. Idempotent — absent block returns the
 * content unchanged, and since no processor writes the marker anymore the
 * block never reappears. Callers apply this ONLY to today's daily;
 * historical dailies are closed records and keep theirs.
 */
export function removeLegacyStartContextSection(content: string): string {
  const range = startContextBlockRange(content);
  if (range === null) return content;
  const before = content.slice(0, range.start).replace(/(?:\r?\n)*$/, "");
  const after = content.slice(range.end).replace(/^(?:\r?\n)*/, "");
  if (before.length === 0) return after;
  if (after.length === 0) return `${before}\n`;
  return `${before}\n\n${after}`;
}

/**
 * Render the close scaffold block (`dome.daily:close`) — the deterministic
 * half of the evening act. Done candidates are plain `-` bullets the human
 * keeps or deletes (the hint line says so); zero candidates renders a single
 * non-bullet "Nothing recorded as settled today." line (zero bullets is what
 * "empty close" means to tomorrow's reader); the still-open line-up
 * compresses to a count + top 3 in surface order; the story pointer is a
 * non-bullet reminder — the close NEVER writes story prose ([[daily]]
 * decision ledger 3). Normative at [[wiki/specs/daily-surface]] §"The close
 * block".
 */
export function closeScaffoldSection(input: {
  readonly doneCandidates: ReadonlyArray<DailyCloseDoneCandidate>;
  readonly stillOpen: ReadonlyArray<DailyOpenLoopSource>;
}): string {
  const lines = [CLOSE_START, "### Done today"];
  if (input.doneCandidates.length === 0) {
    lines.push("Nothing recorded as settled today.");
  } else {
    lines.push(
      "Candidates from today's settles — keep what counts, delete the rest.",
    );
    for (const candidate of input.doneCandidates) {
      const prefix = candidate.status === "dismissed" ? "Dismissed: " : "";
      const origin =
        candidate.originPath === null
          ? ""
          : ` (from [[${candidate.originPath.replace(/\.md$/, "")}]])`;
      lines.push(`- ${prefix}${candidate.body}${origin}`);
    }
  }
  lines.push("### Still open");
  if (input.stillOpen.length === 0) {
    lines.push("- No loops still open.");
  } else {
    const top = input.stillOpen.slice(0, 3).map((item) => item.body);
    const noun = input.stillOpen.length === 1 ? "loop" : "loops";
    lines.push(
      `- ${input.stillOpen.length} ${noun} still open — top: ${top.join("; ")}`,
    );
  }
  lines.push(
    "### Story of the Day",
    "The story stays yours — write it in the ## Story of the Day section below; the close never generates prose.",
    CLOSE_END,
  );
  return lines.join("\n");
}

/**
 * Ensure the close block exists: insert `section` (a full close block
 * including markers) under `## Done` when the block is absent, and leave an
 * existing block — confirmed, edited, or emptied by the human — alone
 * ENTIRELY. The presence gate is the close's whole idempotency story: re-runs
 * are byte-identical no-ops and a human-deleted candidate is never
 * resurrected ([[wiki/specs/daily-surface]] §"The close block").
 */
export function ensureCloseScaffoldSection(input: {
  readonly content: string;
  readonly section: string;
}): string {
  const existing = dailyBlockRange(input.content, CLOSE_BLOCK);
  if (existing !== null) return input.content;
  return insertCloseScaffoldSection(input);
}

/**
 * Extract what tomorrow's mechanical yesterday fallback reads out of a close
 * block: the kept `### Done today` bullets (hint lines and non-bullet text
 * are not kept content) and the parsed `### Still open` count. Returns null
 * when the content carries no close block.
 */
export function closeDigestFromDailyContent(
  content: string,
): DailyCloseDigest | null {
  const { range } = findGeneratedBlock(content, DAILY_OWNER, CLOSE_BLOCK);
  if (range === null) return null;
  const body = content.slice(range.bodyStart, range.bodyEnd);
  const kept: string[] = [];
  let stillOpenCount: number | null = null;
  let section: "done" | "still-open" | "other" = "other";
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      const title = (heading[1] ?? "").toLowerCase();
      section =
        title === "done today"
          ? "done"
          : title === "still open"
            ? "still-open"
            : "other";
      continue;
    }
    if (section === "done" && /^[-*]\s+\S/.test(line)) {
      const cleaned = cleanContextLine(line);
      if (cleaned !== null) kept.push(cleaned);
      continue;
    }
    if (section === "still-open" && stillOpenCount === null) {
      const counted = /^[-*]\s+(\d+)\s+loops?\s+still\s+open\b/.exec(line);
      if (counted !== null) {
        stillOpenCount = Number(counted[1]);
        continue;
      }
      if (/^[-*]\s+No loops still open\b/i.test(line)) stillOpenCount = 0;
    }
  }
  return Object.freeze({
    kept: Object.freeze(kept),
    stillOpenCount,
  });
}

// ----- Private helpers -------------------------------------------------------

export function cleanContextLine(line: string): string | null {
  const stripped = line
    .trim()
    .replace(/^\s*[-*]\s+\[[ xX]\]\s+/, "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "")
    .trim();
  if (stripped.length === 0) return null;
  if (stripped.startsWith("<!--")) return null;
  if (/^#{1,6}\s+/.test(stripped)) return null;
  return truncateContextText(stripped, 160);
}

function renderCompactList(items: ReadonlyArray<string>): string {
  const shown = items.slice(0, 3);
  const suffix = items.length > shown.length
    ? ` (+${items.length - shown.length} more)`
    : "";
  return `${shown.join("; ")}${suffix}`;
}

function truncateContextText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function insertYesterdayFallbackSection(input: {
  readonly content: string;
  readonly section: string;
}): string {
  const startHere = /^## Start Here[ \t]*$/m.exec(input.content);
  if (startHere !== null && startHere.index !== undefined) {
    const insertAt = startHere.index + startHere[0].length;
    const rest = input.content.slice(insertAt).replace(/^(?:\r?\n)*/, "\n\n");
    return `${input.content.slice(0, insertAt)}\n\n${input.section}${rest}`;
  }

  const meetings = /^## Meetings[ \t]*$/m.exec(input.content);
  if (meetings !== null && meetings.index !== undefined) {
    return (
      `${input.content.slice(0, meetings.index)}` +
      `## Start Here\n\n${input.section}\n\n` +
      input.content.slice(meetings.index)
    );
  }

  const openLoops = /^## Open Loops[ \t]*$/m.exec(input.content);
  if (openLoops !== null && openLoops.index !== undefined) {
    return (
      `${input.content.slice(0, openLoops.index)}` +
      `## Start Here\n\n${input.section}\n\n` +
      input.content.slice(openLoops.index)
    );
  }

  const suffix = input.content.endsWith("\n") ? "" : "\n";
  return `${input.content}${suffix}\n## Start Here\n\n${input.section}\n`;
}

function startContextBlockRange(
  content: string,
): { readonly start: number; readonly end: number } | null {
  return dailyBlockRange(content, START_CONTEXT_BLOCK);
}

/**
 * Insert the close block under `## Done` — insertion-anchored, never
 * positional (daily-surface §"The section contract"): a missing heading is
 * created (before `## Story of the Day` when present, appended otherwise)
 * rather than assumed at an offset.
 */
function insertCloseScaffoldSection(input: {
  readonly content: string;
  readonly section: string;
}): string {
  const done = /^## Done[ \t]*$/m.exec(input.content);
  if (done !== null && done.index !== undefined) {
    const insertAt = done.index + done[0].length;
    const rest = input.content.slice(insertAt).replace(/^(?:\r?\n)*/, "\n\n");
    return `${input.content.slice(0, insertAt)}\n\n${input.section}${rest}`;
  }

  const story = /^## Story of the Day[ \t]*$/m.exec(input.content);
  if (story !== null && story.index !== undefined) {
    return (
      `${input.content.slice(0, story.index)}` +
      `## Done\n\n${input.section}\n\n` +
      input.content.slice(story.index)
    );
  }

  const suffix = input.content.endsWith("\n") ? "" : "\n";
  return `${input.content}${suffix}\n## Done\n\n${input.section}\n`;
}

function extractSectionItems(
  content: string,
  heading: string,
): ReadonlyArray<string> {
  const body = headingSectionBody(content, heading);
  if (body === null) return Object.freeze([]);
  const items: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const item = cleanContextLine(line);
    if (item === null) continue;
    items.push(item);
  }
  return Object.freeze(items);
}

function extractStorySummary(content: string): string | null {
  const body = headingSectionBody(content, "Story of the Day");
  if (body === null) return null;
  const paragraphs = body
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) =>
      paragraph
        .split(/\r?\n/)
        .map(cleanContextLine)
        .filter((line): line is string => line !== null)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((paragraph) => paragraph.length > 0);
  const first = paragraphs[0];
  return first === undefined ? null : truncateContextText(first, 220);
}

function headingSectionBody(
  content: string,
  heading: string,
): string | null {
  const match = new RegExp(`^## ${escapeRegExp(heading)}[ \\t]*$`, "m")
    .exec(content);
  if (match === null || match.index === undefined) return null;
  const bodyStart = match.index + (match[0]?.length ?? 0);
  return content.slice(bodyStart, endOfHeadingSection(content, match));
}
