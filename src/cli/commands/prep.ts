// cli/commands/prep: first-class wrapper for the dome.daily.prep view.

import { formatJson } from "../format";
import {
  defaultLocalDateString,
  validateDateOption,
} from "./daily-options";
import {
  firstPartyViewNotFoundMessage,
  printViewCommandError,
  printViewCommandMessages,
  runStructuredViewCommand,
  structuredViewBrokerMessages,
} from "./view-shared";

export type PrepCommandOptions = {
  readonly date?: string | undefined;
  readonly limit?: number | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
};

const DEFAULT_LIMIT = 12;

export async function runPrep(
  options: PrepCommandOptions = {},
): Promise<number> {
  const date = options.date ?? defaultLocalDateString();
  if (!validateDateOption("dome prep", date)) return 64;

  try {
    const run = await runStructuredViewCommand({
      commandLabel: "dome prep",
      commandName: "prep",
      expectedViewName: "dome.daily.prep",
      expectedSchema: "dome.daily.prep/v1",
      commandArgs: Object.freeze({
        date,
        limit: options.limit ?? DEFAULT_LIMIT,
      }),
      vault: options.vault,
      bundlesRoot: options.bundlesRoot,
      notFoundMessage: firstPartyViewNotFoundMessage({
        commandLabel: "dome prep",
        bundleId: "dome.daily",
        processorName: "prep",
      }),
      noStructuredResultMessage:
        "dome prep: prep processor returned no structured result.",
    });

    if (run.kind === "error") {
      printViewCommandError({
        commandLabel: "dome prep",
        json: options.json === true,
        messages: run.messages,
      });
      return run.exitCode;
    }
    printViewCommandMessages(
      structuredViewBrokerMessages("dome prep", run.brokerDiagnostics),
    );

    if (options.json === true) {
      console.log(formatJson(run.data));
    } else {
      console.log(formatPrepResult(run.data));
    }
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    printViewCommandError({
      commandLabel: "dome prep",
      json: options.json === true,
      error: "prep-failed",
      messages: [`dome prep: failed: ${msg}`],
    });
    return 1;
  }
}

type PrepData = {
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
  readonly dueCounts: PrepDueCounts;
  readonly planningItems: ReadonlyArray<PrepItem>;
  readonly markdown: string;
};

type PrepDueCounts = {
  readonly openTasks: DueCounts;
  readonly followups: DueCounts;
};

type DueCounts = {
  readonly overdue: number;
  readonly today: number;
  readonly upcoming: number;
  readonly undated: number;
};

type PrepItem = {
  readonly kind: string;
  readonly text: string;
  readonly path: string;
  readonly line: number | null;
};

function formatPrepResult(data: unknown): string {
  const prep = parsePrepData(data);
  if (prep.markdown.trim().length > 0) return prep.markdown;

  const lines = [
    `DOME prep ${prep.date}`,
    `daily    ${prep.daily.path} | ${prep.daily.exists ? "exists" : "missing"}`,
    `counts   ${prep.counts.openTasks} open tasks | ${prep.counts.followups} followups | ${prep.counts.questions} questions`,
    `due      open tasks ${formatDueCounts(prep.dueCounts.openTasks)} | followups ${formatDueCounts(prep.dueCounts.followups)}`,
    "",
    "Start Here",
  ];
  if (prep.planningItems.length === 0) {
    lines.push("  none");
  } else {
    for (const item of prep.planningItems) {
      lines.push(`  - [${item.kind}] ${item.text} (${sourceLabel(item)})`);
    }
  }
  return lines.join("\n");
}

function parsePrepData(data: unknown): PrepData {
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
    dueCounts: parseDueCounts(record.dueCounts),
    planningItems: Object.freeze(parseItems(record.planningItems)),
    markdown: stringOrEmpty(record.markdown),
  });
}

function parseDueCounts(raw: unknown): PrepDueCounts {
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

function parseItems(raw: unknown): ReadonlyArray<PrepItem> {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(
    raw.map((item) => {
      const record = asRecord(item);
      return Object.freeze({
        kind: stringOrEmpty(record.kind),
        text: stringOrEmpty(record.text),
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

function formatDueCounts(counts: DueCounts): string {
  return [
    `${counts.overdue} overdue`,
    `${counts.today} today`,
    `${counts.upcoming} upcoming`,
    `${counts.undated} undated`,
  ].join(" | ");
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
