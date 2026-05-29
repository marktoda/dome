// cli/commands/today: first-class wrapper for the dome.daily.today view.

import { formatJson } from "../format";
import {
  defaultLocalDateString,
  validateDateOption,
} from "./daily-options";
import {
  printViewCommandMessages,
  runStructuredViewCommand,
  structuredViewBrokerMessages,
} from "./view-shared";

export type TodayCommandOptions = {
  readonly date?: string | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
};

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
      commandArgs: Object.freeze({ date }),
      vault: options.vault,
      bundlesRoot: options.bundlesRoot,
      notFoundMessage:
        "dome today: dome.daily is not installed or no today processor is enabled. " +
        "For older vault configs, run `dome init --refresh-config` to add current first-party defaults.",
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
  readonly daily: {
    readonly path: string;
    readonly exists: boolean;
  };
  readonly counts: {
    readonly openTasks: number;
    readonly followups: number;
    readonly questions: number;
  };
  readonly openTasks: ReadonlyArray<TodayTask>;
  readonly followups: ReadonlyArray<TodayTask>;
  readonly questions: ReadonlyArray<TodayQuestion>;
};

type TodayTask = {
  readonly text: string;
  readonly path: string;
  readonly line: number | null;
  readonly followup: boolean;
};

type TodayQuestion = {
  readonly question: string;
  readonly path: string;
  readonly line: number | null;
};

function formatTodayResult(data: unknown): string {
  const today = parseTodayData(data);
  const lines = [
    `DOME today ${today.date}`,
    `daily    ${today.daily.path} | ${today.daily.exists ? "exists" : "missing"}`,
    `tasks    ${today.counts.openTasks} open | ${today.counts.followups} followups | ${today.counts.questions} questions`,
  ];

  lines.push("");
  lines.push("Open tasks");
  if (today.openTasks.length === 0) {
    lines.push("  none");
  } else {
    for (const task of today.openTasks) {
      const marker = task.followup ? " [followup]" : "";
      lines.push(`  - ${task.text}${marker} (${sourceLabel(task)})`);
    }
  }

  lines.push("");
  lines.push("Follow-ups");
  if (today.followups.length === 0) {
    lines.push("  none");
  } else {
    for (const task of today.followups) {
      lines.push(`  - ${task.text} (${sourceLabel(task)})`);
    }
  }

  if (today.questions.length > 0) {
    lines.push("");
    lines.push("Questions");
    for (const question of today.questions) {
      lines.push(`  - ${question.question} (${sourceLabel(question)})`);
    }
  }

  return lines.join("\n");
}

function parseTodayData(data: unknown): TodayData {
  const record = asRecord(data);
  const daily = asRecord(record.daily);
  const counts = asRecord(record.counts);
  return Object.freeze({
    date: stringOrEmpty(record.date),
    daily: Object.freeze({
      path: stringOrEmpty(daily.path),
      exists: daily.exists === true,
    }),
    counts: Object.freeze({
      openTasks: numberOrZero(counts.openTasks),
      followups: numberOrZero(counts.followups),
      questions: numberOrZero(counts.questions),
    }),
    openTasks: Object.freeze(parseTasks(record.openTasks)),
    followups: Object.freeze(parseTasks(record.followups)),
    questions: Object.freeze(parseQuestions(record.questions)),
  });
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
      return Object.freeze({
        question: stringOrEmpty(record.question),
        path: stringOrEmpty(record.path),
        line: nullableNumber(record.line),
      });
    }),
  );
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
