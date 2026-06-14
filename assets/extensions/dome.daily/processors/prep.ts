// dome.daily.prep — render source-backed planning context for a day.

import {
  viewEffect,
  type Effect,
  type QuestionMetadata,
  type ViewEffect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";
import { questionAutomationLabel } from "../../../../src/question-resolution";

import {
  collectDailyActionState,
  inputDateOrLocalToday,
  parseInputLimit,
  selectDailyActionRows,
  sourceLabel,
  uniqueSourceRefs,
  type DailyActionState,
  type DailyDueCounts,
  type DailyQuestionItem,
  type DailyTaskAttention,
  type DailyTaskItem,
  type DailyTaskPriority,
} from "./action-state";

const SCHEMA = "dome.daily.prep/v1";
const DEFAULT_LIMIT = 12;

const prep = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const limit = parseInputLimit(ctx.input, DEFAULT_LIMIT);
    const actionState = await collectDailyActionState(
      ctx,
      inputDateOrLocalToday(ctx.input, ctx.now()),
    );
    const allPlanningItems = prioritizedPlanningItems(
      actionState,
      Number.MAX_SAFE_INTEGER,
    );
    const planningItems = Object.freeze(allPlanningItems.slice(0, limit));
    const followups = selectDailyActionRows(actionState.followups, limit);
    const openTasks = selectDailyActionRows(actionState.openTasks, limit);
    const questions = selectDailyActionRows(actionState.questions, limit);
    const shown = Object.freeze({
      planningItems: planningItems.length,
      followups: followups.length,
      openTasks: openTasks.length,
      questions: questions.length,
    });
    const omitted = Object.freeze({
      planningItems: Math.max(
        0,
        allPlanningItems.length - shown.planningItems,
      ),
      followups: Math.max(0, actionState.counts.followups - shown.followups),
      openTasks: Math.max(0, actionState.counts.openTasks - shown.openTasks),
      questions: Math.max(0, actionState.counts.questions - shown.questions),
    });
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
      sourceCounts: actionState.sourceCounts,
      dueCounts: actionState.dueCounts,
      shown,
      omitted,
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
  readonly metadata?: QuestionMetadata | null;
  readonly automationPolicy?: string;
  readonly dueDate: string | null;
  readonly priority: DailyTaskPriority | null;
  readonly lastChangedAt: string | null;
  readonly attention: DailyTaskAttention | null;
  readonly evidenceLabel: string;
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
  const key = taskPlanningKey(kind, task);
  if (seen.has(key)) return;
  seen.add(key);
  items.push(Object.freeze({
    kind,
    text: task.text,
    path: task.path,
    line: task.line,
    dueDate: task.dueDate,
    priority: task.priority,
    lastChangedAt: task.lastChangedAt,
    attention: task.attention,
    evidenceLabel: task.evidenceLabel,
    sourceRefs: Object.freeze([...task.sourceRefs]),
  }));
}

function pushQuestionItem(
  items: PrepPlanningItem[],
  seen: Set<string>,
  question: DailyQuestionItem,
): void {
  const key = questionPlanningKey(question);
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
    metadata: question.metadata,
    automationPolicy: question.automationPolicy,
    dueDate: null,
    priority: null,
    lastChangedAt: question.lastChangedAt,
    attention: null,
    evidenceLabel: question.evidenceLabel,
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
  const planningKeys = new Set(input.planningItems.map(planningItemKey));
  const followups = input.followups.filter((task) =>
    !planningKeys.has(taskPlanningKey("followup", task))
  );
  const openTasks = input.openTasks.filter((task) =>
    !planningKeys.has(
      taskPlanningKey(task.followup ? "followup" : "task", task),
    )
  );
  const questions = input.questions.filter((question) =>
    !planningKeys.has(questionPlanningKey(question))
  );
  const lines: string[] = [
    `# Dome Prep: ${input.state.date}`,
    "",
    `Daily note: ${input.state.daily.path} (${input.state.daily.exists ? "exists" : "missing"})`,
    `Counts: ${input.state.counts.openTasks} open tasks, ${input.state.counts.followups} followups, ${input.state.counts.questions} questions`,
    `Daily note scope: ${formatCounts(input.state.sourceCounts.daily)}`,
    `Backlog scope: ${formatCounts(input.state.sourceCounts.backlog)}`,
    `Due: open tasks ${formatDueCounts(input.state.dueCounts.openTasks)}; followups ${formatDueCounts(input.state.dueCounts.followups)}`,
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
  appendTaskSection(
    lines,
    followups,
    input.state.counts.followups,
    "followups",
    input.followups.length - followups.length,
  );

  lines.push("", "## Open Tasks");
  appendTaskSection(
    lines,
    openTasks,
    input.state.counts.openTasks,
    "open tasks",
    input.openTasks.length - openTasks.length,
  );

  if (input.questions.length > 0) {
    lines.push("", "## Questions");
    appendQuestionSection(
      lines,
      questions,
      input.state.counts.questions,
      input.questions.length - questions.length,
    );
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
    lines.push(`  policy: ${questionAutomationLabel(item.metadata)}`);
    lines.push(`  resolve: ${item.resolveCommand}`);
  }
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
  total: number,
  label: string,
  alreadyListed: number,
): void {
  if (tasks.length === 0 && alreadyListed === 0) {
    lines.push("- none");
    return;
  }
  if (alreadyListed > 0) {
    appendAlreadyListedLine(lines, alreadyListed, label);
  }
  for (const source of ["daily", "backlog"] as const) {
    const scoped = tasks.filter((task) => task.source === source);
    if (scoped.length === 0) continue;
    lines.push(`- ${sourceGroupLabel(source)}`);
    for (const task of scoped) {
      const marker = task.followup ? " [followup]" : "";
      lines.push(`  - ${task.text}${marker} (${sourceLabel(task)})`);
    }
  }
  appendMoreLine(lines, total, tasks.length + alreadyListed, label);
}

function appendQuestionSection(
  lines: string[],
  questions: ReadonlyArray<DailyQuestionItem>,
  total: number,
  alreadyListed: number,
): void {
  if (alreadyListed > 0) {
    appendAlreadyListedLine(lines, alreadyListed, "questions");
  }
  for (const source of ["daily", "backlog"] as const) {
    const scoped = questions.filter((question) => question.source === source);
    if (scoped.length === 0) continue;
    lines.push(`- ${sourceGroupLabel(source)}`);
    for (const question of scoped) {
      lines.push(
        `  - [#${question.id}] ${question.question} (${sourceLabel(question)})`,
      );
      lines.push(`    policy: ${questionAutomationLabel(question.metadata)}`);
      lines.push(`    resolve: ${question.resolveCommand}`);
    }
  }
  appendMoreLine(lines, total, questions.length + alreadyListed, "questions");
}

function taskPlanningKey(
  kind: "followup" | "task",
  task: Pick<DailyTaskItem, "path" | "line" | "text">,
): string {
  return [kind, task.path, task.line ?? "", task.text].join("\u0000");
}

function questionPlanningKey(
  question: Pick<DailyQuestionItem, "path" | "line" | "question">,
): string {
  return ["question", question.path, question.line ?? "", question.question].join(
    "\u0000",
  );
}

function planningItemKey(item: PrepPlanningItem): string {
  return [item.kind, item.path, item.line ?? "", item.text].join("\u0000");
}

function appendAlreadyListedLine(
  lines: string[],
  count: number,
  label: string,
): void {
  const itemLabel = count === 1 ? singularLabel(label) : label;
  lines.push(`- ${count} ${itemLabel} already listed in Start Here`);
}

function formatCounts(counts: {
  readonly openTasks: number;
  readonly followups: number;
  readonly questions: number;
}): string {
  return [
    `${counts.openTasks} open tasks`,
    `${counts.followups} followups`,
    `${counts.questions} questions`,
  ].join(", ");
}

function formatDueCounts(counts: DailyDueCounts): string {
  return [
    `${counts.overdue} overdue`,
    `${counts.today} today`,
    `${counts.upcoming} upcoming`,
    `${counts.undated} undated`,
  ].join(", ");
}

function sourceGroupLabel(source: "daily" | "backlog"): string {
  return source === "daily" ? "Daily note" : "Wider wiki backlog";
}

function appendMoreLine(
  lines: string[],
  total: number,
  shown: number,
  label: string,
): void {
  const remaining = total - shown;
  if (remaining <= 0) return;
  const itemLabel = remaining === 1 ? singularLabel(label) : label;
  const hint = `(use --limit ${total} to show all ${label})`;
  lines.push(
    `- ... ${remaining} more ${itemLabel} ${hint}`,
  );
}

function singularLabel(label: string): string {
  if (label === "open tasks") return "open task";
  if (label === "questions") return "question";
  if (label === "followups") return "followup";
  return label;
}

