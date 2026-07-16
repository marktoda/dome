// dome.daily.task-backlog — page the same logical open-task selector as Today.

import {
  viewEffect,
  type Effect,
  type JsonValue,
  type ViewEffect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import {
  buildTaskBacklogList,
  TASK_BACKLOG_LIST_SCHEMA,
  type TaskBacklogTaskInput,
} from "../../../../src/surface/task-backlog";

import {
  collectTaskBacklogCandidates,
  inputDateOrLocalToday,
  parseInputLimit,
  parseInputString,
  uniqueSourceRefs,
} from "./action-state";

const taskBacklog = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const state = await collectTaskBacklogCandidates(
      ctx,
      inputDateOrLocalToday(ctx.input, ctx.now()),
    );
    const document = buildTaskBacklogList({
      date: state.date,
      revision: state.revision,
      tasks: state.tasks satisfies ReadonlyArray<TaskBacklogTaskInput>,
      limit: parseInputLimit(ctx.input, 25),
      cursor: parseInputString(ctx.input, ["cursor"]),
    });
    const scope = uniqueSourceRefs(state.tasks.flatMap((item) => item.sourceRefs));
    const effect: ViewEffect = viewEffect({
      name: "dome.daily.task-backlog.list",
      content: {
        kind: "structured",
        schema: TASK_BACKLOG_LIST_SCHEMA,
        // buildTaskBacklogList conditionally omits every optional field and is
        // schema-validated in contract tests; Zod's inferred optional fields
        // include `undefined`, while Effect.JsonValue correctly does not.
        data: document as unknown as JsonValue,
      },
      scope,
    });
    return [effect];
  },
});

export default taskBacklog;
