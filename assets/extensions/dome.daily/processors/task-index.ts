// dome.daily.task-index — project explicit daily checkboxes into page facts.

import {
  factEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  openTasksFromMarkdown,
  parseDailyPath,
} from "./daily-shared";

const OPEN_TASK_PREDICATE = "dome.daily.open_task";
const FOLLOWUP_PREDICATE = "dome.daily.followup";

const taskIndex: Processor = defineProcessor({
  id: "dome.daily.task-index",
  version: "0.1.0",
  phase: "adoption",
  triggers: [
    {
      kind: "signal",
      name: "document.changed",
      pathPattern: "wiki/dailies/*.md",
    },
    {
      kind: "signal",
      name: "file.created",
      pathPattern: "wiki/dailies/*.md",
    },
    {
      kind: "signal",
      name: "file.deleted",
      pathPattern: "wiki/dailies/*.md",
    },
  ],
  capabilities: [
    { kind: "read", paths: ["wiki/dailies/*.md"] },
    { kind: "graph.write", namespaces: ["dome.daily.*"] },
  ],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const effects: Effect[] = [];
    for (const path of ctx.changedPaths) {
      if (parseDailyPath(path) === null) continue;

      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      for (const task of openTasksFromMarkdown(content)) {
        const ref = ctx.sourceRef(path, {
          startLine: task.line,
          endLine: task.line,
        });
        effects.push(
          factEffect({
            subject: { kind: "page", path },
            predicate: OPEN_TASK_PREDICATE,
            object: { kind: "string", value: task.body },
            assertion: "extracted",
            sourceRefs: [ref],
          }),
        );
        if (task.followup) {
          effects.push(
            factEffect({
              subject: { kind: "page", path },
              predicate: FOLLOWUP_PREDICATE,
              object: { kind: "string", value: task.body },
              assertion: "extracted",
              sourceRefs: [ref],
            }),
          );
        }
      }
    }
    return Object.freeze(effects);
  },
});

export default taskIndex;
