// dome.daily.agenda-with — source-backed agenda for a person or topic.

import {
  viewEffect,
  type Effect,
  type ViewEffect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
  type SearchDocumentResult,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";

import {
  collectDailyActionState,
  inputDateOrLocalToday,
  parseInputLimit,
  parseInputString,
  uniqueSourceRefs,
  type DailyActionState,
  type DailyQuestionItem,
  type DailyTaskItem,
} from "./action-state";

const SCHEMA = "dome.daily.agenda-with/v1";
const DEFAULT_LIMIT = 12;

const agendaWith: Processor = defineProcessor({
  id: "dome.daily.agenda-with",
  version: "0.1.0",
  phase: "view",
  triggers: [{ kind: "command", name: "agenda-with" }],
  capabilities: [{ kind: "read", paths: ["wiki/**/*.md"] }],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (ctx.projection === undefined) {
      throw new Error(
        "dome.daily.agenda-with: ctx.projection is undefined; view-phase processors require a ProjectionQueryView",
      );
    }

    const input = parseAgendaInput(ctx.input);
    const limit = parseInputLimit(ctx.input, DEFAULT_LIMIT);
    const actionState = await collectDailyActionState(
      ctx,
      inputDateOrLocalToday(ctx.input),
    );
    const agendaItems = agendaItemsFor(actionState, input.topic, limit);
    const context = ctx.projection
      .searchDocuments({ query: input.topic, limit })
      .map(contextFromMatch);
    const scope = uniqueSourceRefs([
      ...agendaItems.flatMap((item) => item.sourceRefs),
      ...context.flatMap((entry) => entry.sourceRefs),
      ...actionState.daily.sourceRefs,
    ]);
    const data = Object.freeze({
      schema: SCHEMA,
      topic: input.topic,
      date: actionState.date,
      limit,
      daily: actionState.daily,
      counts: Object.freeze({
        agendaItems: agendaItems.length,
        context: context.length,
      }),
      agendaItems,
      context,
      markdown: renderAgendaMarkdown({
        topic: input.topic,
        state: actionState,
        agendaItems,
        context,
      }),
    });

    const effect: ViewEffect = viewEffect({
      name: "dome.daily.agenda-with",
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

export default agendaWith;

type AgendaInput = {
  readonly topic: string;
};

type AgendaItem = {
  readonly kind: "followup" | "task" | "question";
  readonly text: string;
  readonly path: string;
  readonly line: number | null;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

type AgendaContextEntry = {
  readonly path: string;
  readonly title: string;
  readonly snippet: string;
  readonly rank: number;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

function parseAgendaInput(input: unknown): AgendaInput {
  const topic = parseInputString(input, ["topic", "person"]) ?? "";
  return Object.freeze({ topic });
}

function agendaItemsFor(
  state: DailyActionState,
  topic: string,
  limit: number,
): ReadonlyArray<AgendaItem> {
  const seen = new Set<string>();
  const items: AgendaItem[] = [];

  for (const followup of state.followups) {
    if (!matchesTopic(followup.text, topic)) continue;
    pushTaskItem(items, seen, "followup", followup);
    if (items.length >= limit) return Object.freeze(items);
  }

  for (const question of state.questions) {
    if (!matchesTopic(question.question, topic)) continue;
    pushQuestionItem(items, seen, question);
    if (items.length >= limit) return Object.freeze(items);
  }

  for (const task of state.openTasks) {
    if (task.followup || !matchesTopic(task.text, topic)) continue;
    pushTaskItem(items, seen, "task", task);
    if (items.length >= limit) return Object.freeze(items);
  }

  return Object.freeze(items);
}

function pushTaskItem(
  items: AgendaItem[],
  seen: Set<string>,
  kind: "followup" | "task",
  task: DailyTaskItem,
): void {
  const key = `${kind}\u0000${task.path}\u0000${task.line ?? ""}\u0000${task.text}`;
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
  items: AgendaItem[],
  seen: Set<string>,
  question: DailyQuestionItem,
): void {
  const key =
    `question\u0000${question.path}\u0000${question.line ?? ""}\u0000${question.question}`;
  if (seen.has(key)) return;
  seen.add(key);
  items.push(Object.freeze({
    kind: "question",
    text: question.question,
    path: question.path,
    line: question.line,
    sourceRefs: Object.freeze([...question.sourceRefs]),
  }));
}

function contextFromMatch(match: SearchDocumentResult): AgendaContextEntry {
  return Object.freeze({
    path: match.path,
    title: match.title,
    snippet: stripFtsMarkers(match.snippet),
    rank: match.rank,
    sourceRefs: Object.freeze([...match.sourceRefs]),
  });
}

function renderAgendaMarkdown(input: {
  readonly topic: string;
  readonly state: DailyActionState;
  readonly agendaItems: ReadonlyArray<AgendaItem>;
  readonly context: ReadonlyArray<AgendaContextEntry>;
}): string {
  const lines: string[] = [
    `# Dome Agenda: ${input.topic}`,
    "",
    `Daily note: ${input.state.daily.path} (${input.state.daily.exists ? "exists" : "missing"})`,
    `Counts: ${input.agendaItems.length} agenda items, ${input.context.length} context matches`,
    "",
    "## Agenda Items",
  ];

  if (input.agendaItems.length === 0) {
    lines.push("- No open tasks, follow-ups, or questions matched.");
  } else {
    for (const item of input.agendaItems) {
      lines.push(`- [${item.kind}] ${item.text} (${sourceLabel(item)})`);
    }
  }

  lines.push("", "## Context");
  if (input.context.length === 0) {
    lines.push("- No adopted-state context matches.");
  } else {
    for (const entry of input.context) {
      lines.push(`- ${entry.title} (${entry.path})`);
      if (entry.snippet.length > 0) {
        lines.push(`  ${entry.snippet.replace(/\s+/g, " ")}`);
      }
    }
  }

  lines.push("", "## SourceRefs");
  for (const ref of uniqueSourceRefs([
    ...input.agendaItems.flatMap((item) => item.sourceRefs),
    ...input.context.flatMap((entry) => entry.sourceRefs),
  ])) {
    const range = ref.range === undefined
      ? ""
      : `:${ref.range.startLine}-${ref.range.endLine}`;
    lines.push(`- ${ref.path}${range} @ ${ref.commit.slice(0, 7)}`);
  }

  return lines.join("\n");
}

function matchesTopic(text: string, topic: string): boolean {
  if (topic.trim().length === 0) return false;
  return text.toLocaleLowerCase().includes(topic.toLocaleLowerCase());
}

function stripFtsMarkers(snippet: string): string {
  return snippet.replace(/\[/g, "").replace(/\]/g, "");
}

function sourceLabel(item: {
  readonly path: string;
  readonly line: number | null;
}): string {
  return item.line === null ? item.path : `${item.path}:${item.line}`;
}
