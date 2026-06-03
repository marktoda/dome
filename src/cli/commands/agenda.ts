// cli/commands/agenda: first-class wrapper for dome.daily.agenda-with.

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

export type AgendaCommandOptions = {
  readonly topic: string;
  readonly date?: string | undefined;
  readonly limit?: number | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
};

const DEFAULT_LIMIT = 12;

export async function runAgenda(
  options: AgendaCommandOptions,
): Promise<number> {
  const topic = options.topic.trim();
  if (topic.length === 0) {
    printViewCommandError({
      commandLabel: "dome agenda",
      json: options.json === true,
      error: "agenda-usage",
      messages: ["dome agenda: missing person or topic."],
    });
    return 64;
  }

  const date = options.date ?? defaultLocalDateString();
  if (!validateDateOption("dome agenda", date)) return 64;

  try {
    const run = await runStructuredViewCommand({
      commandLabel: "dome agenda",
      commandName: "agenda-with",
      expectedViewName: "dome.daily.agenda-with",
      expectedSchema: "dome.daily.agenda-with/v1",
      commandArgs: Object.freeze({
        topic,
        date,
        limit: options.limit ?? DEFAULT_LIMIT,
      }),
      vault: options.vault,
      bundlesRoot: options.bundlesRoot,
      notFoundMessage: firstPartyViewNotFoundMessage({
        commandLabel: "dome agenda",
        bundleId: "dome.daily",
        processorName: "agenda",
      }),
      noStructuredResultMessage:
        "dome agenda: agenda processor returned no structured result.",
    });

    if (run.kind === "error") {
      printViewCommandError({
        commandLabel: "dome agenda",
        json: options.json === true,
        messages: run.messages,
      });
      return run.exitCode;
    }
    printViewCommandMessages(
      structuredViewBrokerMessages("dome agenda", run.brokerDiagnostics),
    );

    if (options.json === true) {
      console.log(formatJson(run.data));
    } else {
      console.log(formatAgendaResult(run.data));
    }
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    printViewCommandError({
      commandLabel: "dome agenda",
      json: options.json === true,
      error: "agenda-failed",
      messages: [`dome agenda: failed: ${msg}`],
    });
    return 1;
  }
}

type AgendaData = {
  readonly topic: string;
  readonly date: string;
  readonly counts: {
    readonly agendaItems: number;
    readonly context: number;
  };
  readonly agendaItems: ReadonlyArray<AgendaItem>;
  readonly context: ReadonlyArray<AgendaContextEntry>;
  readonly markdown: string;
};

type AgendaItem = {
  readonly kind: string;
  readonly text: string;
  readonly path: string;
  readonly line: number | null;
};

type AgendaContextEntry = {
  readonly path: string;
  readonly title: string;
  readonly snippet: string;
};

function formatAgendaResult(data: unknown): string {
  const agenda = parseAgendaData(data);
  if (agenda.markdown.trim().length > 0) return agenda.markdown;

  const lines = [
    `DOME agenda ${agenda.topic}`,
    `date     ${agenda.date}`,
    `counts   ${agenda.counts.agendaItems} agenda items | ${agenda.counts.context} context matches`,
    "",
    "Agenda Items",
  ];
  if (agenda.agendaItems.length === 0) {
    lines.push("  none");
  } else {
    for (const item of agenda.agendaItems) {
      lines.push(`  - [${item.kind}] ${item.text} (${sourceLabel(item)})`);
    }
  }

  lines.push("", "Context");
  if (agenda.context.length === 0) {
    lines.push("  none");
  } else {
    for (const entry of agenda.context) {
      lines.push(`  - ${entry.title} (${entry.path})`);
    }
  }
  return lines.join("\n");
}

function parseAgendaData(data: unknown): AgendaData {
  const record = asRecord(data);
  const counts = asRecord(record.counts);
  return Object.freeze({
    topic: stringOrEmpty(record.topic),
    date: stringOrEmpty(record.date),
    counts: Object.freeze({
      agendaItems: numberOrZero(counts.agendaItems),
      context: numberOrZero(counts.context),
    }),
    agendaItems: Object.freeze(parseItems(record.agendaItems)),
    context: Object.freeze(parseContext(record.context)),
    markdown: stringOrEmpty(record.markdown),
  });
}

function parseItems(raw: unknown): ReadonlyArray<AgendaItem> {
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

function parseContext(raw: unknown): ReadonlyArray<AgendaContextEntry> {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(
    raw.map((item) => {
      const record = asRecord(item);
      return Object.freeze({
        path: stringOrEmpty(record.path),
        title: stringOrEmpty(record.title),
        snippet: stringOrEmpty(record.snippet),
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
