// dome.daily.task-index — project explicit markdown action items into facts.

import {
  factEffect,
  questionEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  actionItemsFromMarkdown,
  ambiguousFollowupsFromMarkdown,
} from "./daily-shared";
import {
  AMBIGUOUS_FOLLOWUP_OPTIONS,
  ambiguousFollowupQuestionKey,
} from "./ambiguous-followup-shared";

const OPEN_TASK_PREDICATE = "dome.daily.open_task";
const FOLLOWUP_PREDICATE = "dome.daily.followup";

const taskIndex: Processor = defineProcessor({
  id: "dome.daily.task-index",
  version: "0.1.2",
  phase: "adoption",
  triggers: [
    {
      kind: "signal",
      name: "document.changed",
      pathPattern: "wiki/**/*.md",
    },
    {
      kind: "signal",
      name: "file.created",
      pathPattern: "wiki/**/*.md",
    },
    {
      kind: "signal",
      name: "file.deleted",
      pathPattern: "wiki/**/*.md",
    },
  ],
  capabilities: [
    { kind: "read", paths: ["wiki/**/*.md"] },
    { kind: "graph.write", namespaces: ["dome.daily.*"] },
    { kind: "question.ask" },
  ],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const effects: Effect[] = [];
    for (const path of ctx.changedPaths) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      for (const task of actionItemsFromMarkdown(content)) {
        const ref = ctx.sourceRef(path, lineRange(task.line));
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
      for (const ambiguous of ambiguousFollowupsFromMarkdown(content)) {
        effects.push(
          questionEffect({
            question:
              `Possible follow-up in ${path}:${ambiguous.line}: ` +
              `"${ambiguous.text}". Should Dome track this as a follow-up?`,
            options: AMBIGUOUS_FOLLOWUP_OPTIONS,
            sourceRefs: [ctx.sourceRef(path, lineRange(ambiguous.line))],
            idempotencyKey: ambiguousFollowupQuestionKey({
              version: 1,
              path,
              line: ambiguous.line,
              text: ambiguous.text,
            }),
          }),
        );
      }
    }
    return Object.freeze(effects);
  },
});

export default taskIndex;

function lineRange(
  line: number,
): { readonly startLine: number; readonly endLine: number } {
  return { startLine: line, endLine: line };
}
