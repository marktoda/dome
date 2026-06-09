// dome.agent.brief — deterministic plumbing for the morning brief.
//
// Marker-delimited generated blocks (same pattern as dome.daily's
// start-context / open-loops / carried-forward blocks), defensive calendar
// parsing, the grounding splice that keeps model output inside its own
// blocks, and the deterministic open-question block renderer. Everything
// here is pure string/data work — the LLM never touches these seams.

export const BRIEF_YESTERDAY_START = "<!-- dome.agent.brief:yesterday:start -->";
export const BRIEF_YESTERDAY_END = "<!-- dome.agent.brief:yesterday:end -->";
export const BRIEF_MEETINGS_START = "<!-- dome.agent.brief:meetings:start -->";
export const BRIEF_MEETINGS_END = "<!-- dome.agent.brief:meetings:end -->";
export const BRIEF_QUESTIONS_START = "<!-- dome.agent.brief:questions:start -->";
export const BRIEF_QUESTIONS_END = "<!-- dome.agent.brief:questions:end -->";

export type BriefBlockMarkers = {
  readonly start: string;
  readonly end: string;
};

export const YESTERDAY_BLOCK: BriefBlockMarkers = Object.freeze({
  start: BRIEF_YESTERDAY_START,
  end: BRIEF_YESTERDAY_END,
});
export const MEETINGS_BLOCK: BriefBlockMarkers = Object.freeze({
  start: BRIEF_MEETINGS_START,
  end: BRIEF_MEETINGS_END,
});
export const QUESTIONS_BLOCK: BriefBlockMarkers = Object.freeze({
  start: BRIEF_QUESTIONS_START,
  end: BRIEF_QUESTIONS_END,
});

// ----- Calendar parsing (defensive — the file is untrusted input) -----------

export type CalendarMeeting = {
  readonly time: string | null;
  readonly title: string;
  readonly attendees: ReadonlyArray<string>;
};

const MAX_MEETINGS = 20;
const MAX_TITLE_CHARS = 200;
const MAX_ATTENDEES = 12;

/**
 * Parse a `sources/calendar/YYYY-MM-DD.md` file per the vault-layout shape:
 * top-level list items, optional `HH:MM(–HH:MM)` time, dash separator, title,
 * optional trailing `(attendees: a, b)`. Defensive by contract — frontmatter
 * and headings are skipped, unparsable list items degrade to title-only
 * meetings, counts and field lengths are capped, and the output is data for
 * a prompt, never instructions.
 */
export function parseCalendarDay(
  content: string,
): ReadonlyArray<CalendarMeeting> {
  const meetings: CalendarMeeting[] = [];
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
    const item = /^\s*[-*]\s+(\S.*)$/.exec(line);
    if (item === null) continue;
    const meeting = parseMeetingLine(item[1] ?? "");
    if (meeting !== null) meetings.push(meeting);
    if (meetings.length >= MAX_MEETINGS) break;
  }
  return Object.freeze(meetings);
}

function parseMeetingLine(raw: string): CalendarMeeting | null {
  let rest = raw.trim();
  if (rest.length === 0) return null;

  const attendees: string[] = [];
  const attendeesMatch = /\(attendees:\s*([^)]*)\)\s*$/i.exec(rest);
  if (attendeesMatch !== null) {
    for (const name of (attendeesMatch[1] ?? "").split(",")) {
      const trimmed = name.trim();
      if (trimmed.length > 0 && attendees.length < MAX_ATTENDEES) {
        attendees.push(trimmed);
      }
    }
    rest = rest.slice(0, attendeesMatch.index).trim();
  }

  let time: string | null = null;
  const timeMatch =
    /^(\d{1,2}:\d{2}(?:\s*[–—-]\s*\d{1,2}:\d{2})?)\s*(?:[–—-]\s*)?(.*)$/.exec(
      rest,
    );
  if (timeMatch !== null && (timeMatch[2] ?? "").trim().length > 0) {
    time = (timeMatch[1] ?? "").replace(/\s+/g, "");
    rest = (timeMatch[2] ?? "").trim();
  }

  const title = rest.replace(/^[–—-]\s*/, "").trim().slice(0, MAX_TITLE_CHARS);
  if (title.length === 0) return null;
  return Object.freeze({ time, title, attendees: Object.freeze(attendees) });
}

// ----- Block plumbing --------------------------------------------------------

function blockRange(
  content: string,
  markers: BriefBlockMarkers,
): { readonly start: number; readonly end: number } | null {
  const start = content.indexOf(markers.start);
  if (start < 0) return null;
  const endMarker = content.indexOf(markers.end, start);
  if (endMarker < 0) return null;
  return Object.freeze({ start, end: endMarker + markers.end.length });
}

/** The text between the markers (exclusive), or null when the block is absent. */
export function extractBriefBlockBody(
  content: string,
  markers: BriefBlockMarkers,
): string | null {
  const range = blockRange(content, markers);
  if (range === null) return null;
  return content.slice(range.start + markers.start.length, range.end - markers.end.length);
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
  /** Insert after this block when present (e.g. questions after yesterday). */
  readonly afterBlock?: BriefBlockMarkers;
}): string {
  const existing = blockRange(input.content, input.markers);
  if (existing !== null) {
    const replacement = input.section === null ? "" : input.section;
    return `${input.content.slice(0, existing.start)}${replacement}${input.content.slice(existing.end)}`;
  }
  if (input.section === null) return input.content;

  if (input.afterBlock !== undefined) {
    const anchor = blockRange(input.content, input.afterBlock);
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

/**
 * Marker-injection guard. Dome's HTML comments are exclusively generated
 * block markers (`<!-- dome.daily:* -->`, `<!-- dome.agent.brief:* -->`), so
 * no legitimate model-written body line ever carries one. A model body that
 * smuggles marker lines could fabricate a second copy of another block
 * (`replaceBriefBlock` replaces only the first occurrence, so the smuggled
 * copy would survive the deterministic pass verbatim) or corrupt
 * `dome.daily`'s carry-forward regions — and calendar files are untrusted
 * input that flows into the model, so this is a live prompt-injection path.
 */
const DOME_MARKER_COMMENT = /<!--\s*dome\./;

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
 * through, except lines carrying a `<!-- dome.* -->` marker comment, which
 * are dropped entirely (see DOME_MARKER_COMMENT).
 */
export function groundBriefBlockBody(body: string): GroundedBlockBody {
  const kept: string[] = [];
  const ungrounded: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (DOME_MARKER_COMMENT.test(line)) continue;
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

// ----- Open-question block (deterministic) -----------------------------------

export type BriefOpenQuestion = {
  readonly id: number;
  readonly question: string;
  readonly options?: ReadonlyArray<string>;
};

const MAX_QUESTIONS = 10;

/**
 * Render the open Dome questions batch as a generated block. Deterministic —
 * the model never writes question ids, so a brief can never invite a
 * `dome resolve` against a hallucinated row. Plain bullets (never `- [ ]`
 * checkboxes, which the task extractors would re-ingest as new tasks).
 */
export function questionsBriefSection(
  questions: ReadonlyArray<BriefOpenQuestion>,
): string | null {
  if (questions.length === 0) return null;
  const shown = questions.slice(0, MAX_QUESTIONS);
  const lines = [
    BRIEF_QUESTIONS_START,
    "### Open Dome Questions",
    ...shown.map((q) => {
      const options =
        q.options !== undefined && q.options.length > 0
          ? ` (options: ${q.options.join(" | ")})`
          : "";
      return `- Q${q.id}: ${q.question}${options} — resolve: \`dome resolve ${q.id} <answer>\``;
    }),
  ];
  if (questions.length > shown.length) {
    lines.push(
      `- …and ${questions.length - shown.length} more — see \`dome check --json\``,
    );
  }
  lines.push(BRIEF_QUESTIONS_END);
  return lines.join("\n");
}
