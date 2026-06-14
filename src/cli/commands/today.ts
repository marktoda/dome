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
  runSharedViewCommand,
  structuredViewBrokerMessages,
} from "../../surface/view";
import { validateStructuredRun } from "../../surface/adapter";
import { FIRST_PARTY_VIEWS } from "../../surface/view-catalog";
import {
  printViewCommandError,
  printViewCommandMessages,
} from "./view-shared";
import { formatJson } from "../../surface/format";
import {
  finding,
  glyph,
  headline,
  paint,
  resolveCaps,
  rollup,
  signalLine,
  stripWikilinks,
  truncate,
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
  /** Show full brief prose + source paths. */
  readonly verbose?: boolean | undefined;
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
    const run = await runSharedViewCommand({
      commandLabel: "dome today",
      commandName: FIRST_PARTY_VIEWS.today.command,
      commandArgs: Object.freeze({
        ...(options.date !== undefined ? { date: options.date } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      }),
      vault: options.vault,
      bundlesRoot: options.bundlesRoot,
    });

    // not-found: dome.daily is not installed — render verdict header + finding
    // instead of the bare run-on sentence the notFoundMessage would produce.
    if (run.kind === "not-found") {
      if (options.json === true) {
        printViewCommandError({
          commandLabel: "dome today",
          json: true,
          messages: [
            firstPartyViewNotFoundMessage({
              commandLabel: "dome today",
              bundleId: FIRST_PARTY_VIEWS.today.bundleId,
              processorName: FIRST_PARTY_VIEWS.today.processorName,
            }),
          ],
        });
        return { kind: "error", exitCode: 64 };
      }
      const caps = resolveCaps();
      const lines = [
        headline(
          { cmd: "today", context: basename(vaultPath) },
          { tone: "err", label: "not available" },
          caps,
        ),
        "",
        ...finding(
          {
            severity: "error",
            code: "dome.daily not installed",
            what: "no today processor is enabled for this vault",
            fix: "dome init --refresh-config   (adds current first-party defaults)",
          },
          caps,
        ),
      ];
      console.log(lines.join("\n"));
      return { kind: "error", exitCode: 64 };
    }

    if (run.kind === "usage-error") {
      printViewCommandError({
        commandLabel: "dome today",
        json: options.json === true,
        messages: [run.message],
      });
      return { kind: "error", exitCode: 64 };
    }
    if (run.kind === "runtime-error") {
      printViewCommandError({
        commandLabel: "dome today",
        json: options.json === true,
        messages: [run.message],
      });
      return { kind: "error", exitCode: 1 };
    }
    if (run.kind === "failed") {
      const messages = [
        `dome today: processor '${run.processorId}' finished with ${run.executionStatus}.`,
      ];
      if (run.executionError !== null) {
        messages.push(
          `dome today: ${run.executionError.code}: ${run.executionError.message}`,
        );
      }
      for (const d of run.diagnostics) {
        messages.push(
          `dome today: diagnostic [${d.severity}] ${d.code}: ${d.message}`,
        );
      }
      printViewCommandError({
        commandLabel: "dome today",
        json: options.json === true,
        messages,
      });
      return { kind: "error", exitCode: 1 };
    }

    // run.kind === "ok" — validate the structured view.
    const validated = validateStructuredRun(
      { views: run.views, structured: run.structured },
      {
        viewName: FIRST_PARTY_VIEWS.today.viewName,
        schema: FIRST_PARTY_VIEWS.today.schema,
      },
    );
    if (validated.kind === "problem") {
      const msg = (() => {
        switch (validated.problem.kind) {
          case "no-structured-result":
            return "dome today: today processor returned no structured result.";
          case "multiple-views":
            return `dome today: expected exactly one view '${FIRST_PARTY_VIEWS.today.viewName}', got ${validated.problem.count}.`;
          case "wrong-view":
            return `dome today: expected view '${FIRST_PARTY_VIEWS.today.viewName}', got '${validated.problem.got}'.`;
          case "wrong-schema":
            return `dome today: expected structured schema '${FIRST_PARTY_VIEWS.today.schema}', got '${validated.problem.got}'.`;
          default:
            return "dome today: today processor returned no structured result.";
        }
      })();
      printViewCommandError({
        commandLabel: "dome today",
        json: options.json === true,
        messages: [msg],
      });
      return { kind: "error", exitCode: 1 };
    }

    // TODO: suppress repeated broker diagnostics across watch iterations.
    printViewCommandMessages(
      structuredViewBrokerMessages("dome today", run.brokerDiagnostics),
    );
    if (options.json === true) {
      return { kind: "ok", text: formatJson(validated.data) };
    }
    return {
      kind: "ok",
      text: formatTodayResult(validated.data, resolveCaps(), vaultPath, {
        verbose: options.verbose === true,
      }),
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

type HeroItem =
  | { readonly kind: "task"; readonly item: TodayTaskRow }
  | { readonly kind: "question"; readonly item: TodayQuestionRow };

type BriefField = {
  readonly text: string;
  readonly sourceRef: { readonly path: string };
};

type CalendarField = {
  readonly events: ReadonlyArray<{ readonly time: string; readonly title: string; readonly meta: string }>;
  readonly sourceRef: { readonly path: string };
};

export type FormatTodayOptions = {
  readonly verbose?: boolean;
};

export function formatTodayResult(
  data: unknown,
  caps: Caps,
  vault: string,
  opts: FormatTodayOptions = {},
): string {
  const record = isRecord(data) ? data : {};
  const date = typeof record.date === "string" ? record.date : "today";
  const openTasks = parseTaskRows(record.openTasks);
  const followups = parseTaskRows(record.followups);
  const questions = parseQuestionRows(record.questions);
  const hero = parseHero(record.hero);
  const brief = parseBrief(record.brief);
  const calendar = parseCalendar(record.calendar);
  const counts = isRecord(record.counts) ? record.counts : {};
  const openTasksTotal = numberOr(counts.openTasks, openTasks.length);
  const followupsTotal = numberOr(counts.followups, followups.length);
  const questionsTotal = numberOr(counts.questions, questions.length);

  // Count overdue tasks (dueDate < date)
  const allTasks = [...openTasks, ...followups];
  const overdueCount = allTasks.filter(
    (t) => t.dueDate !== null && t.dueDate < date,
  ).length;
  const totalOpen = openTasksTotal + followupsTotal + questionsTotal;
  const isAllClear = totalOpen === 0;

  // Verdict header
  const verdictLabel = isAllClear
    ? "all clear"
    : overdueCount > 0
    ? `${overdueCount === 1 ? "1 overdue" : `${overdueCount} overdue`} · ${totalOpen} open`
    : `${totalOpen} open`;
  const verdictTone = isAllClear ? "ok" as const : overdueCount > 0 ? "err" as const : "warn" as const;
  const status = { tone: verdictTone, label: verdictLabel };
  const vaultName = basename(vault);

  const lines: string[] = [
    headline({ cmd: "today", context: vaultName }, status, caps),
    "",
  ];

  // Hero action line (→ / >) — never dome decide
  if (hero !== null) {
    if (hero.kind === "task") {
      const item = hero.item;
      const heroText = truncate(stripWikilinks(item.text), 60);
      const urgency = item.dueDate === null
        ? ""
        : item.dueDate < date
        ? `   ${paint(`overdue ${daysBetween(item.dueDate, date)}d`, "err", caps)}`
        : item.dueDate === date
        ? `   ${paint("due today", "warn", caps)}`
        : `   ${paint(`due ${item.dueDate}`, "muted", caps)}`;
      lines.push(`  ${glyph("pointer", caps)} ${heroText}${urgency}`);
    } else {
      const item = hero.item;
      const questionText = truncate(stripWikilinks(item.question), 60);
      lines.push(
        `  ${glyph("pointer", caps)} dome resolve ${item.id}   ${paint(questionText, "muted", caps)}`,
      );
    }
    lines.push("");
  }

  // Calendar summary line
  if (calendar !== null && calendar.events.length > 0) {
    const n = calendar.events.length;
    const evtSummary = `${n} ${n === 1 ? "event" : "events"}`;
    lines.push(
      `  ${paint("today", "muted", caps)}  ${paint(date, "plain", caps)} · ${paint(evtSummary, "muted", caps)}`,
    );
    lines.push("");
  }

  if (!isAllClear) {
    // Group all tasks by bucket
    const LABEL_WIDTH = 6; // "today " padded
    const overdueTasks = allTasks.filter(
      (t) => t.dueDate !== null && t.dueDate < date,
    );
    const dueTodayTasks = allTasks.filter(
      (t) => t.dueDate !== null && t.dueDate === date,
    );
    const openTasksList = allTasks.filter(
      (t) => t.dueDate === null || t.dueDate > date,
    );

    // Max 3 shown per group to keep it compact; overflow → +N in detail
    const MAX_PER_GROUP = 3;

    const TASK_LABEL_MAX = 56;
    const taskLabel = (t: TodayTaskRow) =>
      truncate(stripWikilinks(t.text), TASK_LABEL_MAX);

    if (overdueTasks.length > 0) {
      const shown = overdueTasks.slice(0, MAX_PER_GROUP);
      const overflow = overdueTasks.length - shown.length;
      const detail = shown.map(taskLabel).join(" · ") +
        (overflow > 0 ? ` · +${overflow}` : "");
      lines.push(signalLine("err", "overdue", detail, LABEL_WIDTH, caps));
    }
    if (dueTodayTasks.length > 0) {
      const shown = dueTodayTasks.slice(0, MAX_PER_GROUP);
      const overflow = dueTodayTasks.length - shown.length;
      const detail = shown.map(taskLabel).join(" · ") +
        (overflow > 0 ? ` · +${overflow}` : "");
      lines.push(signalLine("warn", "today", detail, LABEL_WIDTH, caps));
    }
    if (openTasksList.length > 0) {
      const MAX_OPEN = 3;
      const shown = openTasksList.slice(0, MAX_OPEN);
      const overflow = openTasksList.length - shown.length;
      const detail = shown.map(taskLabel).join(" · ") +
        (overflow > 0 ? ` · +${overflow}` : "");
      lines.push(signalLine("plain", "open", detail, LABEL_WIDTH, caps));
    }

    // ? ask line — top question + +N if more
    if (questions.length > 0) {
      const top = questions[0]!;
      const extra = questions.length - 1;
      const extraNote = extra > 0 ? `   ${paint(`+${extra}`, "muted", caps)}` : "";
      const questionLabel = truncate(stripWikilinks(top.question), TASK_LABEL_MAX);
      lines.push(
        `  ? ${paint("ask", "muted", caps)}   #${top.id} ${questionLabel}   ${paint(top.resolveCommand, "ident", caps)}${extraNote}`,
      );
    }

    lines.push("");
    lines.push(rollup([], caps));
  }

  // Brief prose: hidden by default, shown under --verbose
  if (brief !== null) {
    if (opts.verbose === true) {
      lines.push("");
      lines.push(`  ${paint("brief", "muted", caps)}   ${brief.text}`);
      if (brief.sourceRef.path.length > 0) {
        lines.push(`  ${paint(brief.sourceRef.path, "muted", caps)}`);
      }
    } else {
      lines.push("");
      lines.push(
        `  ${paint("--verbose for full brief + sources", "muted", caps)}`,
      );
    }
  }

  return lines.join("\n");
}

function parseHero(raw: unknown): HeroItem | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (kind === "task") {
    const item = isRecord(raw.item) ? raw.item : null;
    if (item === null) return null;
    const text = typeof item.text === "string" ? item.text : "";
    if (text.length === 0) return null;
    return {
      kind: "task",
      item: {
        text,
        path: typeof item.path === "string" ? item.path : "",
        line: typeof item.line === "number" ? item.line : null,
        dueDate: typeof item.dueDate === "string" ? item.dueDate : null,
      },
    };
  }
  if (kind === "question") {
    const item = isRecord(raw.item) ? raw.item : null;
    if (item === null) return null;
    const question = typeof item.question === "string" ? item.question : "";
    if (question.length === 0) return null;
    return {
      kind: "question",
      item: {
        id: typeof item.id === "number" ? item.id : 0,
        question,
        resolveCommand: typeof item.resolveCommand === "string"
          ? item.resolveCommand
          : "dome resolve <id> <value>",
      },
    };
  }
  return null;
}

function parseBrief(raw: unknown): BriefField | null {
  if (!isRecord(raw)) return null;
  const text = typeof raw.text === "string" ? raw.text : null;
  if (text === null || text.length === 0) return null;
  const sourceRef = isRecord(raw.sourceRef) ? raw.sourceRef : null;
  const path = sourceRef !== null && typeof sourceRef.path === "string"
    ? sourceRef.path
    : "";
  return { text, sourceRef: { path } };
}

function parseCalendar(raw: unknown): CalendarField | null {
  if (!isRecord(raw)) return null;
  if (!Array.isArray(raw.events)) return null;
  const events = raw.events.flatMap((ev) => {
    if (!isRecord(ev)) return [];
    const time = typeof ev.time === "string" ? ev.time : null;
    const title = typeof ev.title === "string" ? ev.title : null;
    if (time === null || title === null) return [];
    const meta = typeof ev.meta === "string" ? ev.meta : "";
    return [Object.freeze({ time, title, meta })];
  });
  if (events.length === 0) return null;
  const sourceRef = isRecord(raw.sourceRef) ? raw.sourceRef : null;
  const path = sourceRef !== null && typeof sourceRef.path === "string"
    ? sourceRef.path
    : "";
  return { events, sourceRef: { path } };
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

/**
 * Number of calendar days from `earlier` to `later` (both "YYYY-MM-DD").
 * Returns 0 if the date strings are equal or unparseable.
 */
function daysBetween(earlier: string, later: string): number {
  const a = Date.parse(earlier);
  const b = Date.parse(later);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 0;
  return Math.round((b - a) / 86_400_000);
}
