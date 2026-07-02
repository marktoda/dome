// assets/extensions/dome.daily/processors/calendar-day.ts
//
// Defensive `sources/calendar/YYYY-MM-DD.md` parsing — pure grammar, no
// generated-block plumbing. Lives in dome.daily because it's shared pure
// grammar: dome.agent's brief needs it to read a calendar day, and
// dome.daily's own compose-blocks processor needs the same grammar to
// compose blocks from the same source files. The sanctioned cross-bundle
// import direction is dome.agent -> dome.daily (precedent:
// EDITION_YESTERDAY_BLOCK in daily-types.ts, imported by dome.agent), so this
// lives here rather than in dome.agent; `dome.agent/lib/brief-shared.ts`
// re-exports `parseCalendarDay`/`CalendarMeeting` from this module so
// existing dome.agent imports keep working.

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
