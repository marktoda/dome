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
import {
  collectDailyActionState,
  inputDateOrLocalToday,
  parseInputLimit,
  selectDailyActionRows,
  selectHero,
  uniqueSourceRefs,
  type DailyHero,
} from "./action-state";

// ---------------------------------------------------------------------------
// Cockpit briefing fields — wired to real facts in a later task; always null
// here so the doc schema is stable from the start.
// ---------------------------------------------------------------------------

/**
 * Narrative brief block — populated by the dome.agent.brief processor (CB-T8).
 * Null until that processor runs.
 */
export type DailyBriefField = {
  readonly text: string;
  readonly sourceRef: SourceRef;
} | null;

/**
 * Calendar event block — populated by the dome.agent.calendar.event processor
 * (CB-T8). Null until that processor runs.
 */
export type DailyCalendarField = {
  readonly events: ReadonlyArray<{
    readonly time: string;
    readonly title: string;
    readonly meta: string | null;
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
    const questions = selectDailyActionRows(actionState.questions, limit);
    const shown = Object.freeze({
      openTasks: openTasks.length,
      followups: followups.length,
      questions: questions.length,
    });
    const omitted = Object.freeze({
      openTasks: Math.max(0, actionState.counts.openTasks - shown.openTasks),
      followups: Math.max(0, actionState.counts.followups - shown.followups),
      questions: Math.max(0, actionState.counts.questions - shown.questions),
    });
    const scope = uniqueSourceRefs([
      ...actionState.daily.sourceRefs,
      ...openTasks.flatMap((task) => task.sourceRefs),
      ...followups.flatMap((task) => task.sourceRefs),
      ...questions.flatMap((question) => question.sourceRefs),
    ]);
    // Hero uses the full (non-display-limited) lists so it is not biased by the
    // per-source display cap. brief/calendar are always null here; wired in CB-T8.
    const hero: DailyHero | null = selectHero({
      openTasks: actionState.openTasks,
      questions: actionState.questions,
      today: actionState.date,
    });
    const brief: DailyBriefField = null;
    const calendar: DailyCalendarField = null;
    const data = Object.freeze({
      schema: SCHEMA,
      date: actionState.date,
      limit,
      daily: actionState.daily,
      counts: actionState.counts,
      sourceCounts: actionState.sourceCounts,
      dueCounts: actionState.dueCounts,
      shown,
      omitted,
      openTasks,
      followups,
      questions,
      brief,
      calendar,
      hero,
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

export default today;
