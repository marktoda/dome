// cli/commands/today: the cockpit — `dome today [--watch]`.
//
// A typed wrapper around the command-triggered view-phase processor named
// `today` (dome.daily bundle), exactly the `dome query` posture: the
// processor owns the action surface; this file owns CLI ergonomics and
// rendering. `--watch` re-renders on an interval (v1 cockpit: dumb polling,
// per the v1 plan's open-questions resolution).

import { basename } from "node:path";

import {
  firstPartyViewNotFoundMessage,
  runStructuredViewCommand,
  structuredViewBrokerMessages,
} from "../../surface/view";
import { FIRST_PARTY_VIEWS } from "../../surface/view-catalog";
import {
  printViewCommandError,
  printViewCommandMessages,
} from "./view-shared";
import { formatJson } from "../../surface/format";
import {
  footer,
  headline,
  kv,
  paint,
  resolveCaps,
  section,
  type Caps,
} from "../presenter";
import { resolveVaultPath } from "../../surface/resolve-vault";
import { EX_USAGE } from "../exit-codes";

export type TodayCommandOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly date?: string | undefined;
  readonly limit?: number | undefined;
  readonly json?: boolean | undefined;
  readonly watch?: boolean | undefined;
  /** Watch re-render interval in seconds (default 5, min 1). */
  readonly interval?: number | undefined;
};

/** Injectable watch-loop boundaries (tests). */
export type WatchDeps = {
  readonly sleep?: (ms: number) => Promise<void>;
  /** Stop after N renders (tests); default: until SIGINT. */
  readonly iterations?: number;
  readonly clearScreen?: () => void;
  /** Test seam: replaces renderTodayOnce. */
  readonly render?: (options: TodayCommandOptions) => Promise<RenderOutcome>;
};

export async function runToday(
  options: TodayCommandOptions = {},
  watchDeps: WatchDeps = {},
): Promise<number> {
  if (options.watch === true && options.json === true) {
    printViewCommandError({
      commandLabel: "dome today",
      json: true,
      error: "today-usage",
      messages: ["dome today: --watch and --json are mutually exclusive."],
    });
    return EX_USAGE;
  }
  if (options.watch === true) return watchLoop(options, watchDeps);

  const render = await renderTodayOnce(options);
  if (render.kind === "error") return render.exitCode;
  console.log(render.text);
  return 0;
}

export type RenderOutcome =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "error"; readonly exitCode: number };

async function renderTodayOnce(
  options: TodayCommandOptions,
): Promise<RenderOutcome> {
  const vaultPath = resolveVaultPath(options.vault);
  try {
    const run = await runStructuredViewCommand({
      commandLabel: "dome today",
      commandName: FIRST_PARTY_VIEWS.today.command,
      expectedViewName: FIRST_PARTY_VIEWS.today.viewName,
      expectedSchema: FIRST_PARTY_VIEWS.today.schema,
      commandArgs: Object.freeze({
        ...(options.date !== undefined ? { date: options.date } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      }),
      vault: options.vault,
      bundlesRoot: options.bundlesRoot,
      notFoundMessage: firstPartyViewNotFoundMessage({
        commandLabel: "dome today",
        bundleId: FIRST_PARTY_VIEWS.today.bundleId,
        processorName: FIRST_PARTY_VIEWS.today.processorName,
      }),
      noStructuredResultMessage:
        "dome today: today processor returned no structured result.",
    });
    if (run.kind === "error") {
      printViewCommandError({
        commandLabel: "dome today",
        json: options.json === true,
        messages: run.messages,
      });
      return { kind: "error", exitCode: run.exitCode };
    }
    // TODO: suppress repeated broker diagnostics across watch iterations.
    printViewCommandMessages(
      structuredViewBrokerMessages("dome today", run.brokerDiagnostics),
    );
    if (options.json === true) {
      return { kind: "ok", text: formatJson(run.data) };
    }
    return {
      kind: "ok",
      text: formatTodayResult(run.data, resolveCaps(), vaultPath),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    printViewCommandError({
      commandLabel: "dome today",
      json: options.json === true,
      error: "today-failed",
      messages: [`dome today: failed: ${msg}`],
    });
    return { kind: "error", exitCode: 1 };
  }
}

// ----- watch loop -------------------------------------------------------------

async function watchLoop(
  options: TodayCommandOptions,
  deps: WatchDeps,
): Promise<number> {
  const intervalMs = Math.max(1, options.interval ?? 5) * 1000;
  // Abortable default sleep: stop() wakes the sleeper so ctrl-c exits
  // immediately instead of parking up to a full interval.
  let wake: () => void = () => {};
  let stopped = false;
  const stop = () => { stopped = true; wake(); };
  const sleep = deps.sleep ??
    ((ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(r, ms);
        wake = () => { clearTimeout(t); r(); };
      }));
  const clear = deps.clearScreen ??
    (() => {
      if (process.stdout.isTTY === true) process.stdout.write("\x1b[2J\x1b[H");
    });
  const renderOnce = deps.render ?? renderTodayOnce;

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let last: string | null = null;
  let renders = 0;
  try {
    for (;;) {
      const render = await renderOnce(options);
      renders += 1;
      if (render.kind === "error") return render.exitCode;
      if (render.text !== last) {
        clear();
        console.log(render.text);
        console.log(
          paint(
            `(watch: refreshes every ${intervalMs / 1000}s — ctrl-c to exit)`,
            "muted",
            resolveCaps(),
          ),
        );
        last = render.text;
      }
      if (deps.iterations !== undefined && renders >= deps.iterations) return 0;
      if (stopped) return 0;
      await sleep(intervalMs);
      if (stopped) return 0;
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

// ----- rendering --------------------------------------------------------------

type TodayTaskRow = {
  readonly text: string;
  readonly path: string;
  readonly line: number | null;
  readonly dueDate: string | null;
};

type TodayQuestionRow = {
  readonly id: number;
  readonly question: string;
  readonly resolveCommand: string;
};

function formatTodayResult(data: unknown, caps: Caps, vault: string): string {
  const record = isRecord(data) ? data : {};
  const date = typeof record.date === "string" ? record.date : "today";
  const openTasks = parseTaskRows(record.openTasks);
  const followups = parseTaskRows(record.followups);
  const questions = parseQuestionRows(record.questions);
  const counts = isRecord(record.counts) ? record.counts : {};
  const openTasksTotal = numberOr(counts.openTasks, openTasks.length);
  const followupsTotal = numberOr(counts.followups, followups.length);
  const questionsTotal = numberOr(counts.questions, questions.length);
  const total = openTasksTotal + followupsTotal + questionsTotal;
  const status = total === 0
    ? { tone: "muted" as const, label: "all clear" }
    : { tone: "ok" as const, label: `${total} open` };

  const lines: string[] = [
    headline({ cmd: "today", context: basename(vault) }, status, caps),
  ];
  lines.push(
    ...section(
      "Day",
      kv([{ label: "date", value: date, tone: "plain" }], caps),
      caps,
    ),
  );
  if (openTasks.length > 0) {
    lines.push(
      ...section(
        "Open tasks",
        [
          ...openTasks.map((t) => taskLine(t, caps)),
          ...truncationNote(openTasks.length, openTasksTotal, caps),
        ],
        caps,
      ),
    );
  }
  if (followups.length > 0) {
    lines.push(
      ...section(
        "Follow-ups",
        [
          ...followups.map((t) => taskLine(t, caps)),
          ...truncationNote(followups.length, followupsTotal, caps),
        ],
        caps,
      ),
    );
  }
  if (questions.length > 0) {
    lines.push(
      ...section(
        "Questions",
        [
          ...questions.flatMap((q) => [
            `[#${q.id}] ${q.question}`,
            `   ${paint("resolve:", "muted", caps)} ${q.resolveCommand}`,
          ]),
          ...truncationNote(questions.length, questionsTotal, caps),
        ],
        caps,
      ),
    );
  }
  lines.push(...footer(status, caps));
  return lines.join("\n");
}

/** A muted `(showing N of M)` line when the section was truncated by limit. */
function truncationNote(
  shown: number,
  total: number,
  caps: Caps,
): ReadonlyArray<string> {
  if (total <= shown) return [];
  return [paint(`(showing ${shown} of ${total})`, "muted", caps)];
}

function taskLine(t: TodayTaskRow, caps: Caps): string {
  const where = t.line === null ? t.path : `${t.path}:${t.line}`;
  const due = t.dueDate === null
    ? ""
    : ` ${paint(`due ${t.dueDate}`, "muted", caps)}`;
  return `- [ ] ${t.text}${due}  ${paint(where, "muted", caps)}`;
}

function parseTaskRows(raw: unknown): ReadonlyArray<TodayTaskRow> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const r = isRecord(item) ? item : {};
      const text = typeof r.text === "string" ? r.text : "";
      if (text.length === 0) return null;
      return Object.freeze({
        text,
        path: typeof r.path === "string" ? r.path : "",
        line: typeof r.line === "number" ? r.line : null,
        dueDate: typeof r.dueDate === "string" ? r.dueDate : null,
      });
    })
    .filter((row): row is TodayTaskRow => row !== null);
}

function parseQuestionRows(raw: unknown): ReadonlyArray<TodayQuestionRow> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const r = isRecord(item) ? item : {};
      const question = typeof r.question === "string" ? r.question : "";
      if (question.length === 0) return null;
      return Object.freeze({
        id: typeof r.id === "number" ? r.id : 0,
        question,
        resolveCommand: typeof r.resolveCommand === "string"
          ? r.resolveCommand
          : "dome resolve <id> <value>",
      });
    })
    .filter((row): row is TodayQuestionRow => row !== null);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
