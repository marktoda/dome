// dome.agent.calendar-index — adoption-phase extractor that parses
// sources/calendar/<date>.md and emits one dome.agent.calendar.event FACT
// per meeting. The today view (CB-T8) reads these facts to populate its
// calendar field without re-parsing markdown.
//
// Pattern mirrors dome.agent/processors/brief-index.ts (CB-T6).

import { factEffect, type Effect } from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { parseCalendarDay } from "../lib/brief-shared";

/** The predicate under which calendar events are published to the graph. */
export const CALENDAR_EVENT_PREDICATE = "dome.agent.calendar.event";

/** Path prefix that identifies calendar source day-files. */
const CALENDAR_PATH_PREFIX = "sources/calendar/";

/**
 * A stable id for a calendar event source ref, anchored to `path + time +
 * title` so the id survives attendee edits but changes when the event slot
 * or title changes.
 */
function calendarEventStableId(
  path: string,
  time: string | null,
  title: string,
): string {
  return `calendar-index:${path}:${time ?? ""}:${title}`;
}

/**
 * Build the `meta` field: attendees joined with ", "; empty string when none.
 */
function buildMeta(attendees: ReadonlyArray<string>): string {
  return attendees.join(", ");
}

const calendarIndex = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const effects: Effect[] = [];
    for (const path of ctx.changedPaths) {
      // Only process sources/calendar/*.md paths.
      if (!path.startsWith(CALENDAR_PATH_PREFIX)) continue;

      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      const meetings = parseCalendarDay(content);
      for (const meeting of meetings) {
        const time = meeting.time ?? "";
        const safe = (s: string) => s.replace(/\s+/g, " ").trim();
        const title = meeting.title;
        const meta = buildMeta(meeting.attendees);
        const value = `${time}\t${safe(title)}\t${safe(meta)}`;

        const stableId = calendarEventStableId(path, meeting.time, title);
        const ref = ctx.sourceRef(path, undefined, stableId);
        effects.push(
          factEffect({
            subject: { kind: "page", path },
            predicate: CALENDAR_EVENT_PREDICATE,
            object: { kind: "string", value },
            assertion: "extracted",
            sourceRefs: [ref],
          }),
        );
      }
    }
    return Object.freeze(effects);
  },
});

export default calendarIndex;
