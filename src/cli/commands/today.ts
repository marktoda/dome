// cli/commands/today: the cockpit — `dome today [--watch|--prep|--with <x>]`.
//
// A typed wrapper around the command-triggered view-phase processor named
// `today` (dome.daily bundle), exactly the `dome query` posture: the
// processor owns the action surface; this file owns CLI ergonomics and
// rendering. `--watch` re-renders on an interval (v1 cockpit: dumb polling,
// per the v1 plan's open-questions resolution).
//
// `--prep` and `--with <person-or-topic>` are the day surface's two other
// framings — the same source-backed daily action state rendered as a
// planning packet (dome.daily.prep) or filtered to a person/topic with
// joined search context (dome.daily.agenda-with). Formerly the top-level
// `dome prep` / `dome agenda-with` verbs (cohesion review 2026-07-06: one
// view, one verb); the processors and their handlers are unchanged.

import { basename } from "node:path";

import { z } from "zod";

import {
  runSharedViewCommand,
  structuredViewBrokerMessages,
} from "../../surface/view";
import {
  catalogViewProblemMessage,
  validateStructuredRun,
  viewNotFoundMessage,
} from "../../surface/adapter";
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
  hyperlink,
  originUrl,
  pad,
  paint,
  resolveCaps,
  rollup,
  shortenLabel,
  splitInlineLinks,
  statusGlyph,
  stripEmphasis,
  stripWikilinks,
  visibleWidth,
  wrap,
  type Caps,
  type Tone,
} from "../presenter";
import {
  parseTodayView,
  buildTodayViewModel,
  classifyUrgency,
  priorityMarkerChars,
  type TodaySourceRef,
  type TodayTaskRow,
} from "../../surface/today-view";
import { compareStrings } from "../../core/compare";
import { resolveVaultPath } from "../../surface/resolve-vault";
import { EX_USAGE } from "../exit-codes";
import { runPrep } from "./prep";
import { runAgendaWith } from "./agenda-with";

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
  /** Render the planning-packet framing (dome.daily.prep). */
  readonly prep?: boolean | undefined;
  /** Filter to a person or topic (dome.daily.agenda-with). */
  readonly with?: string | undefined;
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
  // The two alternate framings delegate wholesale (Commander already
  // enforces --prep/--with/--watch exclusivity at the option layer).
  if (options.prep === true) {
    return runPrep({
      date: options.date,
      limit: options.limit,
      vault: options.vault,
      bundlesRoot: options.bundlesRoot,
      json: options.json,
    });
  }
  if (options.with !== undefined) {
    return runAgendaWith({
      topic: options.with,
      date: options.date,
      limit: options.limit,
      vault: options.vault,
      bundlesRoot: options.bundlesRoot,
      json: options.json,
    });
  }
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
            viewNotFoundMessage("dome today", FIRST_PARTY_VIEWS.today),
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
        schemaTag: FIRST_PARTY_VIEWS.today.schemaTag,
        // Lenient degrade: `dome today` must always render something, so it
        // skips the strict contract parse here and enriches the raw data via
        // `parseTodayView` (total) in `formatTodayResult`.
        payload: z.unknown(),
      },
    );
    if (validated.kind === "problem") {
      printViewCommandError({
        commandLabel: "dome today",
        json: options.json === true,
        messages: [
          catalogViewProblemMessage(
            "dome today",
            FIRST_PARTY_VIEWS.today,
            validated.problem,
          ),
        ],
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

export type FormatTodayOptions = {
  readonly verbose?: boolean;
};

export function formatTodayResult(
  data: unknown,
  caps: Caps,
  vault: string,
  opts: FormatTodayOptions = {},
): string {
  const vm = buildTodayViewModel(parseTodayView(data));
  const {
    date,
    totalOpen,
    stillOpen,
    agedBacklog,
    omittedOpenCount,
    brief,
    calendar,
    questions,
    reviews,
    attentionBacklog,
  } = vm;
  const overdueCount = stillOpen.overdue.length + agedBacklog.length;
  const isAllClear = totalOpen === 0;

  // Verdict header
  const verdictLabel = isAllClear
    ? "all clear"
    : overdueCount > 0
    ? `${overdueCount === 1 ? "1" : overdueCount}${omittedOpenCount > 0 ? "+" : ""} overdue · ${totalOpen} open`
    : `${totalOpen} open`;
  const verdictTone = isAllClear ? "ok" as const : overdueCount > 0 ? "err" as const : "warn" as const;
  const status = { tone: verdictTone, label: verdictLabel };
  const vaultName = basename(vault);

  const lines: string[] = [
    headline({ cmd: "today", context: vaultName }, status, caps),
    "",
  ];

  // Brief — the grounded morning framing, shown by default under the verdict.
  // Wikilinks are stripped to their labels (terminal legibility); the source
  // path is shown only under --verbose.
  if (brief !== null) {
    for (const line of wrap(stripWikilinks(brief.text), Math.max(8, caps.width - 2))) {
      lines.push(`  ${line}`);
    }
    if (opts.verbose === true && brief.sourceRef.path.length > 0) {
      lines.push(`  ${paint(brief.sourceRef.path, "muted", caps)}`);
    }
    lines.push("");
  }

  // All-clear calm body: a quiet two-line state under the verdict header,
  // not a bare one-liner. (No hero, no list — there is nothing open.)
  if (isAllClear) {
    lines.push(`  ${paint(glyph("pending", caps), "muted", caps)} nothing needs your attention`);
    lines.push(`  ${paint("you're clear. go make something.", "muted", caps)}`);
    lines.push("");
  }

  // Calendar agenda — a time-gutter list of today's events. Capped (with an
  // overflow line); --verbose shows all. The dim `meta` (attendees) trails the
  // title when present.
  if (calendar !== null && calendar.events.length > 0) {
    lines.push(`  ${paint("agenda", "muted", caps)}  ${paint(date, "plain", caps)}`);
    const AGENDA_CAP = 5;
    const shown = opts.verbose === true
      ? calendar.events.length
      : Math.min(AGENDA_CAP, calendar.events.length);
    const timeWidth = calendar.events
      .slice(0, shown)
      .reduce((m, e) => Math.max(m, visibleWidth(e.time === "" ? "—" : e.time)), 0);
    for (const ev of calendar.events.slice(0, shown)) {
      const time = paint(pad(ev.time === "" ? "—" : ev.time, timeWidth), "muted", caps);
      const metaTail = ev.meta.length > 0 ? `   ${paint(ev.meta, "muted", caps)}` : "";
      const titleBudget = Math.max(8, caps.width - 4 - timeWidth - 3 - visibleWidth(ev.meta) - 3);
      const title = shortenLabel(stripEmphasis(ev.title), titleBudget, caps.unicode);
      lines.push(`    ${time}  ${title}${metaTail}`);
    }
    const more = calendar.events.length - shown;
    if (more > 0) lines.push(`    ${paint(`+${more} more`, "muted", caps)}`);
    lines.push("");
  }

  if (!isAllClear) {
    // Hero-deduped, urgency-bucketed sections come from the view-model — the CLI
    // no longer derives "overdue"/"due today"/etc. itself.
    const { overdue, dueToday, thisWeek, later, someday } = stillOpen;

    const taskWidth = Math.max(24, caps.width - 4); // "  <glyph> " leader = 4 cols
    const arrow = caps.unicode ? "↗" : "->";

    // Render one task row: clean sentence (links pulled out, shortened) + a
    // trailing clickable affordance per link, then a single origin ↗ if set.
    // The URL never enters the visible width, so it can never be sliced.
    // `indent` (default 0) adds that many space columns AFTER the leader and
    // shrinks the taskWidth budget by the same amount so the width invariant holds.
    const renderRow = (t: TodayTaskRow, tone: Tone, indent: number = 0): void => {
      const { text: rawRowText, links } = splitInlineLinks(t.text);
      const text = stripEmphasis(rawRowText);
      const arrowWidth = visibleWidth(arrow); // ↗ (U+2197) is 2 cols, not 1
      const MAX_LINK_LABEL = 24;
      // Cap each affordance label, then reserve the EXACT visible width of the
      // trailing affordances block — "   " + Σ(label + arrow) + (N-1)×"  " —
      // measured against the capped labels, so the rendered tail and the
      // reserve can never disagree (the OSC 8 escape itself is zero-width).
      const affs = links.map((l) => ({
        label: shortenLabel(l.label, MAX_LINK_LABEL, caps.unicode),
        url: l.url,
      }));
      const linkReserve =
        affs.length === 0
          ? 0
          : 3 +
            affs.reduce((a, x) => a + visibleWidth(x.label) + arrowWidth, 0) +
            (affs.length - 1) * 2;
      // Reserve width for the origin ↗ affordance when present.
      const originReserve = t.origin !== undefined ? 3 + arrowWidth : 0;
      // Priority marker gutter: a fixed 3-col cell ("▲▲ ") between the glyph and
      // the text so marked and unmarked rows align at the same text column. The
      // marker (highest/high in `err`, low/lowest in `muted`) is reserved out of
      // the text budget like indent, keeping the row within taskWidth.
      const MARKER_GUTTER = 3;
      const markerRaw = priorityMarkerChars(t.priority, caps.unicode);
      const markerTone: Tone =
        t.priority === "highest" || t.priority === "high" ? "err" : "muted";
      const marker = markerRaw.length > 0
        ? `${paint(pad(markerRaw, MARKER_GUTTER - 1), markerTone, caps)} `
        : " ".repeat(MARKER_GUTTER);
      // Reduce available label width by the extra indent + marker gutter to keep total ≤ taskWidth.
      const effectiveWidth = taskWidth - indent - MARKER_GUTTER;
      const label = shortenLabel(text, Math.max(0, effectiveWidth - linkReserve - originReserve), caps.unicode);
      const g = paint(statusGlyph(tone, caps), tone, caps);
      const affordances = affs
        .map((x) => paint(hyperlink(`${x.label}${arrow}`, x.url, caps), "ident", caps))
        .join("  ");
      const inlineTail = affs.length > 0 ? `   ${affordances}` : "";
      const originTail =
        t.origin !== undefined
          ? `   ${paint(hyperlink(arrow, originUrl(t.origin, vault), caps), "ident", caps)}`
          : "";
      const indentStr = " ".repeat(indent);
      lines.push(`  ${g} ${marker}${indentStr}${label}${inlineTail}${originTail}`);
      if (opts.verbose === true) {
        const why = taskWhyLine(t, date);
        if (why.length > 0) {
          for (const whyLine of wrap(why, Math.max(8, caps.width - 6))) {
            lines.push(`      ${paint(whyLine, "muted", caps)}`);
          }
        }
      }
    };

    const CLUSTER_MIN = 3;
    const OVERDUE_CAP = 6;
    const TODAY_CAP = 4;
    const THIS_WEEK_CAP = 4;
    const LATER_CAP = 3;
    const SOMEDAY_CAP = 3;
    const AGED_BACKLOG_CAP = 3;
    const capOf = (n: number): number => (opts.verbose === true ? Number.POSITIVE_INFINITY : n);

    // Group shown tasks by entity clusters, then emit bucket header + clusters + ungrouped.
    // Returns how many tasks were shown (for overflow accounting — unchanged).
    const section = (header: string, items: ReadonlyArray<TodayTaskRow>, capN: number, tone: Tone): number => {
      if (items.length === 0) return 0;
      lines.push(`  ${paint(header, "muted", caps)}`);
      const shown = Math.min(capOf(capN), items.length);
      const shownSlice = items.slice(0, shown);

      // Tally entity → count over the shown slice.
      const entityCount = new Map<string, number>();
      for (const t of shownSlice) {
        for (const e of (t.entities ?? [])) {
          entityCount.set(e, (entityCount.get(e) ?? 0) + 1);
        }
      }

      // Entities with count >= CLUSTER_MIN are qualifying clusters.
      const clusterEntities = new Set(
        [...entityCount.entries()]
          .filter(([, n]) => n >= CLUSTER_MIN)
          .map(([e]) => e),
      );

      // Assign each shown task to its dominant cluster (most members; ties: alphabetical slug).
      // Tasks with no qualifying entity are ungrouped (clusterKey === null).
      const clusterKey = (t: TodayTaskRow): string | null => {
        const qualifying = (t.entities ?? []).filter((e) => clusterEntities.has(e));
        if (qualifying.length === 0) return null;
        return qualifying.reduce((best, e) => {
          const bc = entityCount.get(best) ?? 0;
          const ec = entityCount.get(e) ?? 0;
          if (ec > bc) return e;
          if (ec === bc && e < best) return e;
          return best;
        });
      };

      // Sort clusters by member count desc, tie alphabetical.
      const sortedClusters = [...clusterEntities].sort((a, b) => {
        const diff = (entityCount.get(b) ?? 0) - (entityCount.get(a) ?? 0);
        return diff !== 0 ? diff : compareStrings(a, b);
      });

      // Build map: cluster entity -> member tasks (in original bucket order).
      const clusterMembers = new Map<string, TodayTaskRow[]>();
      for (const e of sortedClusters) clusterMembers.set(e, []);
      const ungrouped: TodayTaskRow[] = [];
      for (const t of shownSlice) {
        const key = clusterKey(t);
        if (key !== null) {
          clusterMembers.get(key)!.push(t);
        } else {
          ungrouped.push(t);
        }
      }

      // Emit clusters first, then ungrouped flat.
      const CLUSTER_INDENT = 2;
      for (const e of sortedClusters) {
        const members = clusterMembers.get(e)!;
        // An entity can pass CLUSTER_MIN co-occurrence yet lose all its tasks to a
        // higher-count dominant cluster — skip such now-empty clusters.
        if (members.length === 0) continue;
        lines.push(`  ${paint(`${e}  (${members.length})`, "muted", caps)}`);
        for (const t of members) renderRow(t, tone, CLUSTER_INDENT);
      }
      for (const t of ungrouped) renderRow(t, tone);

      return shown;
    };

    const overdueShown = section("OVERDUE", overdue, OVERDUE_CAP, "err");
    const todayShown = section("TODAY", dueToday, TODAY_CAP, "warn");
    const thisWeekShown = section("THIS WEEK", thisWeek, THIS_WEEK_CAP, "plain");
    const laterShown = section("LATER", later, LATER_CAP, "plain");
    const somedayShown = section("SOMEDAY", someday, SOMEDAY_CAP, "plain");
    const agedBacklogShown = section(
      "OLDER BACKLOG · 30+ DAYS OVERDUE",
      agedBacklog,
      AGED_BACKLOG_CAP,
      "err",
    );

    // Renderer caps apply only to rows actually loaded into the payload. Rows
    // absent from the producer's bounded selection are reported independently:
    // --verbose can reveal renderer-capped rows, but cannot reveal omitted rows.
    const overdueMore = Math.max(0, overdue.length - overdueShown);
    const agedBacklogMore = Math.max(0, agedBacklog.length - agedBacklogShown);
    const loadedNonOverdue = dueToday.length + thisWeek.length + later.length + someday.length;
    const shownNonOverdue = todayShown + thisWeekShown + laterShown + somedayShown;
    const otherMore = Math.max(0, loadedNonOverdue - shownNonOverdue);
    if (overdueMore > 0 || agedBacklogMore > 0 || otherMore > 0) {
      const parts: string[] = [];
      if (overdueMore > 0) parts.push(`${overdueMore} more overdue`);
      if (agedBacklogMore > 0) parts.push(`${agedBacklogMore} more older backlog`);
      if (otherMore > 0) parts.push(`${otherMore} more`);
      lines.push(`  ${paint(`… ${parts.join(" · ")} · dome today --verbose`, "muted", caps)}`);
    }
    if (omittedOpenCount > 0) {
      lines.push(
        `  ${paint(`… ${omittedOpenCount} additional open ${omittedOpenCount === 1 ? "item" : "items"} omitted from this view`, "muted", caps)}`,
      );
    }

    // ? ask line — top question + +N if more. Shortened at a word/clause
    // boundary (like the task rows), never chopped mid-word.
    if (questions.length > 0) {
      const top = questions[0]!;
      const extra = questions.length - 1;
      const extraNote = extra > 0 ? `   ${paint(`+${extra}`, "muted", caps)}` : "";
      const askWidth = Math.max(24, caps.width - 40);
      const questionLabel = shortenLabel(stripEmphasis(top.question), askWidth, caps.unicode);
      lines.push(
        `  ? ${paint("ask", "muted", caps)}   #${top.id} ${questionLabel}   ${paint(top.resolveCommand, "ident", caps)}${extraNote}`,
      );
    }
    if (reviews.length > 0) {
      const top = reviews[0]!;
      const extra = reviews.length - 1;
      const extraNote = extra > 0 ? `   ${paint(`+${extra}`, "muted", caps)}` : "";
      const reviewLabel = shortenLabel(stripEmphasis(top.reason), Math.max(24, caps.width - 34), caps.unicode);
      lines.push(
        `  ◇ ${paint("review", "muted", caps)}   P${top.id} ${reviewLabel}   ${paint(top.reviewCommand, "ident", caps)}${extraNote}`,
      );
    }
    if (attentionBacklog > 0) {
      lines.push(
        `  ${paint(`… ${attentionBacklog} more in owner backlog · dome check --decisions`, "muted", caps)}`,
      );
    }

    lines.push("");
    lines.push(rollup([], caps));
  }

  return lines.join("\n");
}

function taskWhyLine(task: TodayTaskRow, today: string): string {
  const parts = [
    dueWhy(task, today),
    ...sourceWhy(task),
    task.origin !== undefined ? `origin ${task.origin}` : null,
  ].filter((part): part is string => part !== null && part.length > 0);
  return parts.length === 0 ? "" : `why: ${parts.join(" · ")}`;
}

function dueWhy(task: TodayTaskRow, today: string): string {
  const urgency = classifyUrgency(task.dueDate, today);
  switch (urgency.kind) {
    case "overdue":
      return `overdue by ${urgency.days}d (${task.dueDate})`;
    case "due-today":
      return "due today";
    case "this-week":
      return `due this week (${urgency.date})`;
    case "later":
      return `due later (${urgency.date})`;
    case "someday":
      return "no due date";
  }
}

function sourceWhy(task: TodayTaskRow): ReadonlyArray<string> {
  const location = task.evidenceLabel ?? formatTaskLocation(task);
  const originRef = firstBackingRef(task);
  if (originRef !== null && originRef.path !== task.path) {
    return [
      `source-backed from ${formatSourceRef(originRef)}`,
      withLocation("carried-forward projection", location),
    ];
  }
  if (task.source === "backlog") return [withLocation("source-backed backlog", location)];
  if (task.source === "daily") return [withLocation("daily-local", location)];
  return location.length > 0 ? [`source ${location}`] : [];
}

function firstBackingRef(task: TodayTaskRow): TodaySourceRef | null {
  const refs = task.sourceRefs ?? [];
  return refs.find((ref) => ref.path !== task.path) ?? refs[0] ?? null;
}

function formatTaskLocation(task: TodayTaskRow): string {
  if (task.path.length === 0) return "";
  return task.line === null ? task.path : `${task.path}:${task.line}`;
}

function formatSourceRef(ref: TodaySourceRef): string {
  const line = ref.range?.startLine;
  return line === undefined ? ref.path : `${ref.path}:${line}`;
}

function withLocation(label: string, location: string): string {
  return location.length === 0 ? label : `${label} at ${location}`;
}
