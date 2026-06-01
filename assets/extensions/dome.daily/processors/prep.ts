// dome.daily.prep — render source-backed planning context for a day.

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
import type { SourceRef } from "../../../../src/core/source-ref";

import {
  collectDailyActionState,
  inputDateOrLocalToday,
  parseInputLimit,
  uniqueSourceRefs,
  type DailyActionState,
  type DailyQuestionItem,
  type DailyTaskItem,
} from "./action-state";

const SCHEMA = "dome.daily.prep/v1";
const DEFAULT_LIMIT = 12;

const prep: Processor = defineProcessor({
  id: "dome.daily.prep",
  version: "0.1.1",
  phase: "view",
  triggers: [{ kind: "command", name: "prep" }],
  capabilities: [{ kind: "read", paths: ["wiki/**/*.md"] }],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const limit = parseInputLimit(ctx.input, DEFAULT_LIMIT);
    const actionState = await collectDailyActionState(
      ctx,
      inputDateOrLocalToday(ctx.input),
    );
    const planningItems = prioritizedPlanningItems(actionState, limit);
    const followups = Object.freeze(actionState.followups.slice(0, limit));
    const openTasks = Object.freeze(actionState.openTasks.slice(0, limit));
    const questions = Object.freeze(actionState.questions.slice(0, limit));
    const scope = prepScope({
      state: actionState,
      planningItems,
      followups,
      openTasks,
      questions,
    });
    const data = Object.freeze({
      schema: SCHEMA,
      date: actionState.date,
      limit,
      daily: actionState.daily,
      counts: actionState.counts,
      planningItems,
      followups,
      openTasks,
      questions,
      markdown: renderPrepMarkdown({
        state: actionState,
        planningItems,
        followups,
        openTasks,
        questions,
        scope,
      }),
    });

    const effect: ViewEffect = viewEffect({
      name: "dome.daily.prep",
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

export default prep;

type PrepPlanningItem = {
  readonly kind: "followup" | "task" | "question";
  readonly text: string;
  readonly path: string;
  readonly line: number | null;
  readonly questionId?: number;
  readonly options?: ReadonlyArray<string>;
  readonly resolveCommand?: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

function prioritizedPlanningItems(
  state: DailyActionState,
  limit: number,
): ReadonlyArray<PrepPlanningItem> {
  const seen = new Set<string>();
  const items: PrepPlanningItem[] = [];

  for (const followup of state.followups) {
    pushTaskItem(items, seen, "followup", followup);
    if (items.length >= limit) return Object.freeze(items);
  }

  for (const question of state.questions) {
    pushQuestionItem(items, seen, question);
    if (items.length >= limit) return Object.freeze(items);
  }

  for (const task of state.openTasks) {
    if (task.followup) continue;
    pushTaskItem(items, seen, "task", task);
    if (items.length >= limit) return Object.freeze(items);
  }

  return Object.freeze(items);
}

function pushTaskItem(
  items: PrepPlanningItem[],
  seen: Set<string>,
  kind: "followup" | "task",
  task: DailyTaskItem,
): void {
  const key = `${task.path}\u0000${task.line ?? ""}\u0000${task.text}`;
  if (seen.has(key)) return;
  seen.add(key);
  items.push(Object.freeze({
    kind,
    text: task.text,
    path: task.path,
    line: task.line,
    sourceRefs: Object.freeze([...task.sourceRefs]),
  }));
}

function pushQuestionItem(
  items: PrepPlanningItem[],
  seen: Set<string>,
  question: DailyQuestionItem,
): void {
  const key = `${question.path}\u0000${question.line ?? ""}\u0000${question.question}`;
  if (seen.has(key)) return;
  seen.add(key);
  items.push(Object.freeze({
    kind: "question",
    text: question.question,
    path: question.path,
    line: question.line,
    questionId: question.id,
    options: Object.freeze([...question.options]),
    resolveCommand: question.resolveCommand,
    sourceRefs: Object.freeze([...question.sourceRefs]),
  }));
}

function renderPrepMarkdown(input: {
  readonly state: DailyActionState;
  readonly planningItems: ReadonlyArray<PrepPlanningItem>;
  readonly followups: ReadonlyArray<DailyTaskItem>;
  readonly openTasks: ReadonlyArray<DailyTaskItem>;
  readonly questions: ReadonlyArray<DailyQuestionItem>;
  readonly scope: ReadonlyArray<SourceRef>;
}): string {
  const lines: string[] = [
    `# Dome Prep: ${input.state.date}`,
    "",
    `Daily note: ${input.state.daily.path} (${input.state.daily.exists ? "exists" : "missing"})`,
    `Counts: ${input.state.counts.openTasks} open tasks, ${input.state.counts.followups} followups, ${input.state.counts.questions} questions`,
    "",
    "## Start Here",
  ];

  if (input.planningItems.length === 0) {
    lines.push("- No source-backed planning items found.");
  } else {
    for (const item of input.planningItems) {
      appendPlanningItem(lines, item);
    }
  }

  lines.push("", "## Follow-ups");
  appendTaskSection(lines, input.followups);

  lines.push("", "## Open Tasks");
  appendTaskSection(lines, input.openTasks);

  if (input.questions.length > 0) {
    lines.push("", "## Questions");
    for (const question of input.questions) {
      appendQuestionItem(lines, question);
    }
  }

  lines.push("", "## SourceRefs");
  for (const ref of input.scope) {
    const range = ref.range === undefined
      ? ""
      : `:${ref.range.startLine}-${ref.range.endLine}`;
    lines.push(`- ${ref.path}${range} @ ${ref.commit.slice(0, 7)}`);
  }

  return lines.join("\n");
}

function appendPlanningItem(lines: string[], item: PrepPlanningItem): void {
  if (item.kind !== "question") {
    lines.push(`- [${item.kind}] ${item.text} (${sourceLabel(item)})`);
    return;
  }
  lines.push(
    `- [question #${item.questionId ?? "?"}] ${item.text} (${sourceLabel(item)})`,
  );
  if (item.resolveCommand !== undefined) {
    lines.push(`  resolve: ${item.resolveCommand}`);
  }
}

function appendQuestionItem(
  lines: string[],
  question: DailyQuestionItem,
): void {
  lines.push(
    `- [#${question.id}] ${question.question} (${sourceLabel(question)})`,
  );
  lines.push(`  resolve: ${question.resolveCommand}`);
}

function prepScope(input: {
  readonly state: DailyActionState;
  readonly planningItems: ReadonlyArray<PrepPlanningItem>;
  readonly followups: ReadonlyArray<DailyTaskItem>;
  readonly openTasks: ReadonlyArray<DailyTaskItem>;
  readonly questions: ReadonlyArray<DailyQuestionItem>;
}): ReadonlyArray<SourceRef> {
  return uniqueSourceRefs([
    ...input.state.daily.sourceRefs,
    ...input.planningItems.flatMap((item) => item.sourceRefs),
    ...input.followups.flatMap((item) => item.sourceRefs),
    ...input.openTasks.flatMap((item) => item.sourceRefs),
    ...input.questions.flatMap((item) => item.sourceRefs),
  ]);
}

function appendTaskSection(
  lines: string[],
  tasks: ReadonlyArray<DailyTaskItem>,
): void {
  if (tasks.length === 0) {
    lines.push("- none");
    return;
  }
  for (const task of tasks) {
    const marker = task.followup ? " [followup]" : "";
    lines.push(`- ${task.text}${marker} (${sourceLabel(task)})`);
  }
}

function sourceLabel(item: {
  readonly path: string;
  readonly line: number | null;
}): string {
  return item.line === null ? item.path : `${item.path}:${item.line}`;
}
