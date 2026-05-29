// dome.daily.carry-forward — copy yesterday's open tasks into a new daily.
//
// The processor reacts to created daily pages, reads the previous daily, and
// replaces a stable generated section in today's note. It preserves authored
// task text and adds only a source backlink.

import {
  patchEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  carriedForwardSection,
  dailyPath,
  openTasksFromMarkdown,
  parseDailyPath,
  previousLocalDate,
  replaceCarriedForwardSection,
} from "./daily-shared";

const carryForward: Processor = defineProcessor({
  id: "dome.daily.carry-forward",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    {
      kind: "signal",
      name: "file.created",
      pathPattern: "wiki/dailies/*.md",
    },
  ],
  capabilities: [
    { kind: "read", paths: ["wiki/dailies/*.md"] },
    { kind: "patch.auto", paths: ["wiki/dailies/*.md"] },
  ],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const effects: Effect[] = [];
    for (const path of ctx.changedPaths) {
      const today = parseDailyPath(path);
      if (today === null) continue;

      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      const yesterday = previousLocalDate(today);
      const yesterdayPath = dailyPath(yesterday);
      const yesterdayContent = await ctx.snapshot.readFile(yesterdayPath);
      if (yesterdayContent === null) continue;

      const tasks = openTasksFromMarkdown(yesterdayContent);
      if (tasks.length === 0) continue;

      const nextContent = replaceCarriedForwardSection({
        content,
        section: carriedForwardSection({ yesterday, tasks }),
      });
      if (nextContent === content) continue;

      const change: FileChangeInput = {
        kind: "write",
        path,
        content: nextContent,
      };

      effects.push(
        patchEffect({
          mode: "auto",
          changes: [change],
          reason: `dome.daily: carry forward open tasks into ${path}`,
          sourceRefs: tasks.map((task) =>
            ctx.sourceRef(yesterdayPath, {
              startLine: task.line,
              endLine: task.line,
            }),
          ),
        }),
      );
    }
    return Object.freeze(effects);
  },
});

export default carryForward;
