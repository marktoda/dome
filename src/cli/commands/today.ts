// cli/commands/today: first-class wrapper for the dome.daily.today view.

import { formatJson } from "../format";
import { resolveQuestionCommand } from "../../question-resolution";
import {
  defaultLocalDateString,
  validateDateOption,
} from "./daily-options";
import {
  firstPartyViewNotFoundMessage,
  printViewCommandMessages,
  runStructuredViewCommand,
  structuredViewBrokerMessages,
} from "./view-shared";

export type TodayCommandOptions = {
  readonly date?: string | undefined;
  readonly limit?: number | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
};

const DEFAULT_LIMIT = 12;

export async function runToday(
  options: TodayCommandOptions = {},
): Promise<number> {
  const date = options.date ?? defaultLocalDateString();
  if (!validateDateOption("dome today", date)) return 64;

  try {
    const run = await runStructuredViewCommand({
      commandLabel: "dome today",
      commandName: "today",
      expectedViewName: "dome.daily.today",
      expectedSchema: "dome.daily.today/v1",
      commandArgs: Object.freeze({
        date,
        limit: options.limit ?? DEFAULT_LIMIT,
      }),
      vault: options.vault,
      bundlesRoot: options.bundlesRoot,
      notFoundMessage: firstPartyViewNotFoundMessage({
        commandLabel: "dome today",
        bundleId: "dome.daily",
        processorName: "today",
      }),
      noStructuredResultMessage:
        "dome today: today processor returned no structured result.",
    });

    if (run.kind === "error") {
      printViewCommandMessages(run.messages);
      return run.exitCode;
    }
    printViewCommandMessages(
      structuredViewBrokerMessages("dome today", run.brokerDiagnostics),
    );

    if (options.json === true) {
      console.log(formatJson(run.data));
    } else {
      console.log(formatTodayResult(run.data));
    }
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`dome today: failed: ${msg}`);
    return 1;
  }
}

type TodayData = {
  readonly date: string;
  readonly limit: number;
  readonly daily: {
    readonly path: string;
    readonly exists: boolean;
  };
  readonly counts: {
    readonly openTasks: number;
    readonly followups: number;
    readonly questions: number;
  };
  readonly sourceCounts: TodaySourceCounts;
  readonly dueCounts: TodayDueCounts;
  readonly openTasks: ReadonlyArray<TodayTask>;
  readonly followups: ReadonlyArray<TodayTask>;
  readonly questions: ReadonlyArray<TodayQuestion>;
};

type TodaySource = "daily" | "backlog";

type TodayCounts = {
  readonly openTasks: number;
  readonly followups: number;
  readonly questions: number;
};

type TodaySourceCounts = {
  readonly daily: TodayCounts;
  readonly backlog: TodayCounts;
};

type TodayDueCounts = {
  readonly openTasks: DueCounts;
  readonly followups: DueCounts;
};

type DueCounts = {
  readonly overdue: number;
  readonly today: number;
  readonly upcoming: number;
  readonly undated: number;
};

type TodayTask = {
  readonly text: string;
  readonly path: string;
  readonly line: number | null;
  readonly source: TodaySource;
  readonly followup: boolean;
};

type TodayQuestion = {
  readonly id: number;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly resolveCommand: string;
  readonly path: string;
  readonly line: number | null;
  readonly source: TodaySource;
};

function formatTodayResult(data: unknown): string {
  const today = parseTodayData(data);
  const dailyStatus = today.daily.exists ? "exists" : "missing";
  const lines = [
    `DOME today ${today.date}`,
    `daily    ${today.daily.path} | ${dailyStatus} | ${
      formatCounts(today.sourceCounts.daily)
    }`,
    `backlog  ${formatCounts(today.sourceCounts.backlog)}`,
    `tasks    ${today.counts.openTasks} open | ${today.counts.followups} followups | ${today.counts.questions} questions`,
    `due      open ${formatDueCounts(today.dueCounts.openTasks)} | followups ${formatDueCounts(today.dueCounts.followups)}`,
  ];

  lines.push("");
  lines.push("Open tasks");
  appendTaskGroups({
    lines,
    tasks: today.openTasks,
    sourceCounts: today.sourceCounts,
    total: today.counts.openTasks,
    countKey: "openTasks",
    itemLabel: "open tasks",
    formatTask: (task) => {
      const marker = task.followup ? " [followup]" : "";
      return `${task.text}${marker}`;
    },
  });

  lines.push("");
  lines.push("Follow-ups");
  appendTaskGroups({
    lines,
    tasks: today.followups,
    sourceCounts: today.sourceCounts,
    total: today.counts.followups,
    countKey: "followups",
    itemLabel: "followups",
    formatTask: (task) => task.text,
  });

  if (today.questions.length > 0) {
    lines.push("");
    lines.push("Questions");
    appendQuestionGroups(lines, today);
  }

  return lines.join("\n");
}

function parseTodayData(data: unknown): TodayData {
  const record = asRecord(data);
  const daily = asRecord(record.daily);
  const counts = asRecord(record.counts);
  return Object.freeze({
    date: stringOrEmpty(record.date),
    limit: numberOrZero(record.limit),
    daily: Object.freeze({
      path: stringOrEmpty(daily.path),
      exists: daily.exists === true,
    }),
    counts: Object.freeze({
      openTasks: numberOrZero(counts.openTasks),
      followups: numberOrZero(counts.followups),
      questions: numberOrZero(counts.questions),
    }),
    sourceCounts: parseSourceCounts(record.sourceCounts),
    dueCounts: parseDueCounts(record.dueCounts),
    openTasks: Object.freeze(parseTasks(record.openTasks)),
    followups: Object.freeze(parseTasks(record.followups)),
    questions: Object.freeze(parseQuestions(record.questions)),
  });
}

function appendTaskGroups(input: {
  readonly lines: string[];
  readonly tasks: ReadonlyArray<TodayTask>;
  readonly sourceCounts: TodaySourceCounts;
  readonly total: number;
  readonly countKey: keyof TodayCounts;
  readonly itemLabel: string;
  readonly formatTask: (task: TodayTask) => string;
}): void {
  if (input.total === 0) {
    input.lines.push("  none");
    return;
  }
  for (const source of ["daily", "backlog"] as const) {
    const totalForSource = input.sourceCounts[source][input.countKey];
    if (totalForSource === 0) continue;
    const tasks = input.tasks.filter((task) => task.source === source);
    input.lines.push(`  ${sourceLabelForGroup(source)}`);
    if (tasks.length === 0) {
      appendMoreLine(
        input.lines,
        totalForSource,
        0,
        input.itemLabel,
        "    ",
        input.total,
      );
      continue;
    }
    for (const task of tasks) {
      input.lines.push(
        `    - ${input.formatTask(task)} (${sourceLabel(task)})`,
      );
    }
    appendMoreLine(
      input.lines,
      totalForSource,
      tasks.length,
      input.itemLabel,
      "    ",
      input.total,
    );
  }
}

function appendQuestionGroups(lines: string[], today: TodayData): void {
  for (const source of ["daily", "backlog"] as const) {
    const totalForSource = today.sourceCounts[source].questions;
    if (totalForSource === 0) continue;
    const questions = today.questions.filter(
      (question) => question.source === source,
    );
    lines.push(`  ${sourceLabelForGroup(source)}`);
    for (const question of questions) {
      const text =
        `    - [#${question.id}] ${question.question} (${sourceLabel(question)})`;
      lines.push(
        text,
      );
      lines.push(`      resolve: ${question.resolveCommand}`);
    }
    appendMoreLine(
      lines,
      totalForSource,
      questions.length,
      "questions",
      "    ",
      today.counts.questions,
    );
  }
}

function sourceLabelForGroup(source: TodaySource): string {
  return source === "daily" ? "Daily note" : "Wider wiki backlog";
}

function appendMoreLine(
  lines: string[],
  total: number,
  shown: number,
  label: string,
  indent = "  ",
  limitHintTotal = total,
): void {
  const remaining = total - shown;
  if (remaining <= 0) return;
  const hint = `(use --limit ${limitHintTotal} to show all)`;
  lines.push(
    `${indent}... ${remaining} more ${label} ${hint}`,
  );
}

function parseTasks(raw: unknown): ReadonlyArray<TodayTask> {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(
    raw.map((item) => {
      const record = asRecord(item);
      return Object.freeze({
        text: stringOrEmpty(record.text),
        path: stringOrEmpty(record.path),
        line: nullableNumber(record.line),
        source: parseSource(record.source),
        followup: record.followup === true,
      });
    }),
  );
}

function parseQuestions(raw: unknown): ReadonlyArray<TodayQuestion> {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(
    raw.map((item) => {
      const record = asRecord(item);
      const id = numberOrZero(record.id);
      const options = Object.freeze(parseStringArray(record.options));
      return Object.freeze({
        id,
        question: stringOrEmpty(record.question),
        options,
        resolveCommand: stringOrEmpty(record.resolveCommand) ||
          resolveQuestionCommand({ id, options }),
        path: stringOrEmpty(record.path),
        line: nullableNumber(record.line),
        source: parseSource(record.source),
      });
    }),
  );
}

function parseSourceCounts(raw: unknown): TodaySourceCounts {
  const record = asRecord(raw);
  return Object.freeze({
    daily: parseCounts(record.daily),
    backlog: parseCounts(record.backlog),
  });
}

function parseDueCounts(raw: unknown): TodayDueCounts {
  const record = asRecord(raw);
  return Object.freeze({
    openTasks: parseDueCountRecord(record.openTasks),
    followups: parseDueCountRecord(record.followups),
  });
}

function parseDueCountRecord(raw: unknown): DueCounts {
  const record = asRecord(raw);
  return Object.freeze({
    overdue: numberOrZero(record.overdue),
    today: numberOrZero(record.today),
    upcoming: numberOrZero(record.upcoming),
    undated: numberOrZero(record.undated),
  });
}

function parseCounts(raw: unknown): TodayCounts {
  const record = asRecord(raw);
  return Object.freeze({
    openTasks: numberOrZero(record.openTasks),
    followups: numberOrZero(record.followups),
    questions: numberOrZero(record.questions),
  });
}

function parseSource(raw: unknown): TodaySource {
  return raw === "daily" ? "daily" : "backlog";
}

function formatCounts(counts: TodayCounts): string {
  return [
    `${counts.openTasks} open`,
    `${counts.followups} followups`,
    `${counts.questions} questions`,
  ].join(" | ");
}

function formatDueCounts(counts: DueCounts): string {
  return [
    `${counts.overdue} overdue`,
    `${counts.today} today`,
    `${counts.upcoming} upcoming`,
    `${counts.undated} undated`,
  ].join(" | ");
}

function parseStringArray(raw: unknown): ReadonlyArray<string> {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(raw.filter((item): item is string =>
    typeof item === "string"
  ));
}

function sourceLabel(item: {
  readonly path: string;
  readonly line: number | null;
}): string {
  return item.line === null ? item.path : `${item.path}:${item.line}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
