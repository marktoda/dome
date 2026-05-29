// cli/commands/today: first-class wrapper for the dome.daily.today view.

import { formatJson } from "../format";
import { runSharedViewCommand } from "./view-shared";

export type TodayCommandOptions = {
  readonly date?: string | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
};

export async function runToday(
  options: TodayCommandOptions = {},
): Promise<number> {
  const date = options.date ?? localDateString(new Date());
  if (!isDateString(date)) {
    console.error(
      "dome today: invalid --date. Expected YYYY-MM-DD, for example 2026-01-05.",
    );
    return 64;
  }

  try {
    const run = await runSharedViewCommand({
      commandLabel: "dome today",
      commandName: "today",
      commandArgs: Object.freeze({ date }),
      vault: options.vault,
      bundlesRoot: options.bundlesRoot,
    });

    if (run.kind === "usage-error") {
      console.error(run.message);
      return 64;
    }
    if (run.kind === "runtime-error") {
      console.error(run.message);
      return 1;
    }

    const result = run.result;
    if (result.kind === "not-found") {
      console.error(
        "dome today: dome.daily is not installed or no today processor is enabled.",
      );
      return 64;
    }
    if (result.kind === "failed") {
      console.error(
        `dome today: processor '${result.processorId}' finished with ${result.executionStatus}.`,
      );
      if (result.executionError !== undefined) {
        console.error(
          `dome today: ${result.executionError.code}: ${result.executionError.message}`,
        );
      }
      for (const d of [...result.diagnostics, ...result.brokerDiagnostics]) {
        console.error(
          `dome today: diagnostic [${d.severity}] ${d.code}: ${d.message}`,
        );
      }
      return 1;
    }

    for (const d of result.brokerDiagnostics) {
      console.error(
        `dome today: broker diagnostic [${d.severity}] ${d.code}: ${d.message}`,
      );
    }

    const view = run.capturedViews[0] ?? result.effects[0];
    if (view === undefined || view.content.kind !== "structured") {
      console.error("dome today: today processor returned no structured result.");
      return 1;
    }

    if (options.json === true) {
      console.log(formatJson(view.content.data));
    } else {
      console.log(formatTodayResult(view.content.data));
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

function localDateString(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function isDateString(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [, yyyy, mm, dd] = match;
  if (yyyy === undefined || mm === undefined || dd === undefined) return false;
  const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  return date.getFullYear() === Number(yyyy) &&
    date.getMonth() === Number(mm) - 1 &&
    date.getDate() === Number(dd);
}
