// dome.daily.task-index — project explicit markdown action items into facts.

import {
  factEffect,
  questionEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import { actionItemsFromMarkdown, ambiguousFollowupsFromMarkdown } from "./action-extraction";
import { FOLLOWUP_PREDICATE, OPEN_TASK_PREDICATE } from "./action-state";
import { openLoopStableId, taskStableId } from "./open-loop-surface";
import {
  AMBIGUOUS_FOLLOWUP_OPTIONS,
  ambiguousFollowupQuestionKey,
} from "./ambiguous-followup-shared";

const taskIndex = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const effects: Effect[] = [];
    for (const path of ctx.changedPaths) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      for (const task of actionItemsFromMarkdown(content)) {
        const stableId = taskStableId({
          sourcePath: path,
          body: task.body,
          ...(task.anchor !== undefined ? { anchor: task.anchor } : {}),
        });
        const ref = ctx.sourceRef(path, lineRange(task.line), stableId);
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
        const stableId = openLoopStableId({
          sourcePath: path,
          body: ambiguous.text,
        });
        effects.push(
          questionEffect({
            question:
              `Possible follow-up in ${path}:${ambiguous.line}: ` +
              `"${ambiguous.text}". Should Dome track this as a follow-up?`,
            options: AMBIGUOUS_FOLLOWUP_OPTIONS,
            sourceRefs: [
              ctx.sourceRef(path, lineRange(ambiguous.line), stableId),
            ],
            idempotencyKey: ambiguousFollowupQuestionKey({
              version: 2,
              path,
              text: ambiguous.text,
            }),
            metadata: {
              risk: "low",
              confidence: 0.65,
              recommendedAnswer: "track",
              automationPolicy: "agent-safe",
            },
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
