// dome.daily.today — render the source-backed action surface for a day.

import {
  viewEffect,
  type Effect,
  type ViewEffect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  collectDailyActionState,
  inputDateOrLocalToday,
  parseInputLimit,
  uniqueSourceRefs,
} from "./action-state";

const SCHEMA = "dome.daily.today/v1";
const DEFAULT_LIMIT = 12;

const today: Processor = defineProcessor({
  id: "dome.daily.today",
  version: "0.1.3",
  phase: "view",
  triggers: [{ kind: "command", name: "today" }],
  capabilities: [{ kind: "read", paths: ["wiki/**/*.md"] }],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const limit = parseInputLimit(ctx.input, DEFAULT_LIMIT);
    const actionState = await collectDailyActionState(
      ctx,
      inputDateOrLocalToday(ctx.input),
    );
    const openTasks = Object.freeze(actionState.openTasks.slice(0, limit));
    const followups = Object.freeze(actionState.followups.slice(0, limit));
    const questions = Object.freeze(actionState.questions.slice(0, limit));
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
    const data = Object.freeze({
      schema: SCHEMA,
      date: actionState.date,
      limit,
      daily: actionState.daily,
      counts: actionState.counts,
      sourceCounts: actionState.sourceCounts,
      shown,
      omitted,
      openTasks,
      followups,
      questions,
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
