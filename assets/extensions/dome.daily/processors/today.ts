// dome.daily.today — render the source-backed action surface for a day.

import {
  viewEffect,
  type Effect,
  type ViewEffect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import type { SourceRef } from "../../../../src/core/source-ref";
// Erased type import — the dome.daily.today/v1 wire contract. No runtime zod
// dependency crosses into this bundle; this only compile-checks that the
// emitted ViewEffect data carries the consumed contract fields.
import type { TodayPayload } from "../../../../src/surface/today-view";
import {
  collectDailyActionState,
  inputDateOrLocalToday,
  parseInputLimit,
  selectDailyActionRows,
  selectHero,
  uniqueSourceRefs,
  type DailyHero,
} from "./action-state";
import type { FactEffect } from "../../../../src/core/effect";

// ---------------------------------------------------------------------------
// Cockpit briefing fields — assembled from projection facts (CB-T8).
// ---------------------------------------------------------------------------

/**
 * Narrative brief block — assembled from dome.agent.brief facts by CB-T8.
 * Null when no brief fact exists for today's daily note path.
 */
export type DailyBriefField = {
  readonly text: string;
  readonly sourceRef: SourceRef;
} | null;

/**
 * Calendar event block — assembled from dome.agent.calendar.event facts by
 * CB-T8. Null when no calendar event facts exist for today's calendar source
 * path (sources/calendar/<date>.md).
 */
export type DailyCalendarField = {
  readonly events: ReadonlyArray<{
    readonly time: string;
    readonly title: string;
    readonly meta: string;
  }>;
  readonly sourceRef: SourceRef;
} | null;

const SCHEMA = "dome.daily.today/v1";
const DEFAULT_LIMIT = 12;

const today = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const limit = parseInputLimit(ctx.input, DEFAULT_LIMIT);
    const actionState = await collectDailyActionState(
      ctx,
      inputDateOrLocalToday(ctx.input, ctx.now()),
    );
    const openTasks = selectDailyActionRows(actionState.openTasks, limit);
    const followups = selectDailyActionRows(actionState.followups, limit);
    const questions = actionState.questions.slice(0, limit);
    const reviews = actionState.reviews.slice(0, limit);
    const shown = Object.freeze({
      openTasks: openTasks.length,
      followups: followups.length,
      questions: questions.length,
      reviews: reviews.length,
    });
    const omitted = Object.freeze({
      openTasks: Math.max(0, actionState.counts.openTasks - shown.openTasks),
      followups: Math.max(0, actionState.counts.followups - shown.followups),
      questions: Math.max(0, actionState.counts.questions - shown.questions),
      reviews: Math.max(0, actionState.counts.reviews - shown.reviews),
    });
    const scope = uniqueSourceRefs([
      ...actionState.daily.sourceRefs,
      ...openTasks.flatMap((task) => task.sourceRefs),
      ...followups.flatMap((task) => task.sourceRefs),
      ...questions.flatMap((question) => question.sourceRefs),
      ...reviews.flatMap((review) => review.sourceRefs),
    ]);
    // Hero uses the full (non-display-limited) lists so it is not biased by the
    // per-source display cap.
    const hero: DailyHero | null = selectHero({
      openTasks: actionState.openTasks,
      questions: actionState.questions,
      today: actionState.date,
    });

    // brief — assembled from the dome.agent.brief fact whose subject path
    // matches today's daily note path (one fact per daily note, at most one match).
    const brief: DailyBriefField = assembleBriefField(
      ctx.projection?.facts({ predicate: "dome.agent.brief" }) ?? [],
      actionState.daily.path,
    );

    // calendar — assembled from dome.agent.calendar.event facts whose subject
    // path matches the sources/calendar/<date>.md path for today.
    const calendarSourcePath = `sources/calendar/${actionState.date}.md`;
    const calendar: DailyCalendarField = assembleCalendarField(
      ctx.projection?.facts({ predicate: "dome.agent.calendar.event" }) ?? [],
      calendarSourcePath,
    );
    // The consumed wire contract (dome.daily.today/v1), compile-checked against
    // the shared TodayPayload type. The extra envelope fields below are spread
    // on after — the contract pins the consumed subset, not the full envelope.
    const payload = {
      date: actionState.date,
      counts: actionState.counts,
      openTasks,
      followups,
      questions,
      reviews,
      attentionBacklog: actionState.attentionBacklog,
      brief,
      calendar,
      hero,
      daily: actionState.daily,
    } satisfies TodayPayload;
    const data = Object.freeze({
      schema: SCHEMA,
      ...payload,
      limit,
      sourceCounts: actionState.sourceCounts,
      dueCounts: actionState.dueCounts,
      shown,
      omitted,
    });

    const effect: ViewEffect = viewEffect({
      name: "dome.daily.today",
      content: {
        kind: "structured",
        schema: SCHEMA,
        data,
      },
      scope,
    });
    return [effect];
  },
});

// ---------------------------------------------------------------------------
// Brief + calendar assembly helpers (CB-T8)
// ---------------------------------------------------------------------------

/**
 * Derive the subject path from a fact: the fact's subject when it is a page
 * ref, otherwise fall back to the first sourceRef's path.
 */
function factSubjectPath(fact: FactEffect): string {
  if (fact.subject.kind === "page") return String(fact.subject.path);
  return fact.sourceRefs[0]?.path as string ?? "";
}

/**
 * Build the DailyBriefField from dome.agent.brief facts. Picks the single
 * fact whose subject path matches today's daily note path. Returns null when
 * no match exists (facts only — no markdown parsing).
 */
function assembleBriefField(
  facts: ReadonlyArray<FactEffect>,
  dailyNotePath: string,
): DailyBriefField {
  const match = facts.find(
    (f) => factSubjectPath(f) === dailyNotePath,
  );
  if (match === undefined) return null;
  const ref = match.sourceRefs[0];
  if (ref === undefined) return null;
  const text = match.object.kind === "string" ? match.object.value : "";
  return Object.freeze({ text, sourceRef: Object.freeze(ref) });
}

/**
 * Build the DailyCalendarField from dome.agent.calendar.event facts. Picks
 * facts whose subject path matches the calendar source path for today. Each
 * fact's object value is a tab-delimited "time\ttitle\tmeta" string; values
 * without exactly two tabs are skipped defensively. Events are sorted by
 * their time field. Returns null when there are no matching facts.
 */
function assembleCalendarField(
  facts: ReadonlyArray<FactEffect>,
  calendarSourcePath: string,
): DailyCalendarField {
  const matched = facts.filter(
    (f) => factSubjectPath(f) === calendarSourcePath,
  );
  if (matched.length === 0) return null;

  type CalendarEvent = {
    readonly time: string;
    readonly title: string;
    readonly meta: string;
  };

  const events: CalendarEvent[] = [];
  for (const fact of matched) {
    const raw = fact.object.kind === "string" ? fact.object.value : "";
    const parts = raw.split("\t");
    // Require exactly three parts (two tab delimiters).
    if (parts.length !== 3) continue;
    const [time, title, meta] = parts;
    if (time === undefined || title === undefined || meta === undefined) continue;
    events.push(Object.freeze({ time, title, meta }));
  }

  if (events.length === 0) return null;

  // Sort by time field; empty time (untimed events) sorts before all others.
  events.sort((a, b) => {
    if (a.time === b.time) return 0;
    if (a.time === "") return -1;
    if (b.time === "") return 1;
    return a.time < b.time ? -1 : 1;
  });

  const ref = matched[0]!.sourceRefs[0];
  if (ref === undefined) return null;

  return Object.freeze({
    events: Object.freeze(events),
    sourceRef: Object.freeze(ref),
  });
}

export default today;
