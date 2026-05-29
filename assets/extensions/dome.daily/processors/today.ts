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
} from "./action-state";

const SCHEMA = "dome.daily.today/v1";

const today: Processor = defineProcessor({
  id: "dome.daily.today",
  version: "0.1.0",
  phase: "view",
  triggers: [{ kind: "command", name: "today" }],
  capabilities: [{ kind: "read", paths: ["wiki/**/*.md"] }],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const actionState = await collectDailyActionState(
      ctx,
      inputDateOrLocalToday(ctx.input),
    );
    const data = Object.freeze({
      schema: SCHEMA,
      date: actionState.date,
      daily: actionState.daily,
      counts: actionState.counts,
      openTasks: actionState.openTasks,
      followups: actionState.followups,
      questions: actionState.questions,
    });

    const effect: ViewEffect = viewEffect({
      name: "dome.daily.today",
      content: {
        kind: "structured",
        schema: SCHEMA,
        data,
      },
      scope: actionState.scope,
    });
    return [effect];
  },
});

export default today;
