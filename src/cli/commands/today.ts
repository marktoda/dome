// cli/commands/today: the cockpit — `dome today [--watch]`.
//
// A typed wrapper around the command-triggered view-phase processor named
// `today` (dome.daily bundle), exactly the `dome query` posture: the
// processor owns the action surface; this file owns CLI ergonomics and
// rendering. `--watch` re-renders on an interval (v1 cockpit: dumb polling,
// per the v1 plan's open-questions resolution).

import { basename } from "node:path";

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
  paint,
  resolveCaps,
  rollup,
  shortenLabel,
  splitInlineLinks,
  statusGlyph,
  stripEmphasis,
  visibleWidth,
  type Caps,
  type Tone,
} from "../presenter";
import { daysBetween, parseTodayView, type TodayTaskRow } from "../../surface/today-view";
import { compareStrings } from "../../core/compare";
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
        schema: FIRST_PARTY_VIEWS.today.schema,
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
  const view = parseTodayView(data);
  const { date, openTasks, followups, questions, hero, brief, calendar, counts } = view;
  const openTasksTotal = counts.openTasks;
  const followupsTotal = counts.followups;
  const questionsTotal = counts.questions;

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
    const heroArrow = caps.unicode ? "↗" : "->";
    const heroArrowWidth = visibleWidth(heroArrow);
    if (hero.kind === "task") {
      const item = hero.item;
      // Urgency suffix — compute its plain visible width BEFORE paint so we
      // can reserve the right number of columns.
      const urgencyPlain = item.dueDate === null
        ? ""
        : item.dueDate < date
        ? `   overdue ${daysBetween(item.dueDate, date)}d`
        : item.dueDate === date
        ? `   due today`
        : `   due ${item.dueDate}`;
      const urgencyPainted = item.dueDate === null
        ? ""
        : item.dueDate < date
        ? `   ${paint(`overdue ${daysBetween(item.dueDate, date)}d`, "err", caps)}`
        : item.dueDate === date
        ? `   ${paint("due today", "warn", caps)}`
        : `   ${paint(`due ${item.dueDate}`, "muted", caps)}`;
      const urgencyWidth = visibleWidth(urgencyPlain);

      // Mirror renderRow: split out inline links, strip emphasis, shorten.
      const { text: rawText, links: heroLinks } = splitInlineLinks(item.text);
      const heroText = stripEmphasis(rawText);
      const MAX_LINK_LABEL = 24;
      const heroAffs = heroLinks.map((l) => ({
        label: shortenLabel(l.label, MAX_LINK_LABEL, caps.unicode),
        url: l.url,
      }));
      const heroLinkReserve =
        heroAffs.length === 0
          ? 0
          : 3 +
            heroAffs.reduce((a, x) => a + visibleWidth(x.label) + heroArrowWidth, 0) +
            (heroAffs.length - 1) * 2;
      const heroOriginReserve = item.origin !== undefined ? 3 + heroArrowWidth : 0;
      // "  → " leader = 4 cols (2 indent + pointer char + space); same as taskWidth.
      const heroTaskWidth = Math.max(24, caps.width - 4);
      const heroBudget = Math.max(0, heroTaskWidth - urgencyWidth - heroLinkReserve - heroOriginReserve);
      const heroLabel = shortenLabel(heroText, heroBudget, caps.unicode);

      const heroAffordances = heroAffs
        .map((x) => paint(hyperlink(`${x.label}${heroArrow}`, x.url, caps), "ident", caps))
        .join("  ");
      const heroInlineTail = heroAffs.length > 0 ? `   ${heroAffordances}` : "";
      const heroOriginTail =
        item.origin !== undefined
          ? `   ${paint(hyperlink(heroArrow, originUrl(item.origin, vault), caps), "ident", caps)}`
          : "";
      lines.push(`  ${glyph("pointer", caps)} ${heroLabel}${heroInlineTail}${heroOriginTail}${urgencyPainted}`);
    } else {
      const item = hero.item;
      const questionText = shortenLabel(stripEmphasis(item.question), 60, caps.unicode);
      lines.push(
        `  ${glyph("pointer", caps)} dome resolve ${item.id}   ${paint(questionText, "muted", caps)}`,
      );
    }
    lines.push("");
  }

  // All-clear calm body: a quiet two-line state under the verdict header,
  // not a bare one-liner. (No hero, no list — there is nothing open.)
  if (isAllClear) {
    lines.push(`  ${paint(glyph("pending", caps), "muted", caps)} nothing open · inbox empty`);
    lines.push(`  ${paint("you're clear. go make something.", "muted", caps)}`);
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
    const isHeroTask = (t: TodayTaskRow): boolean =>
      hero !== null && hero.kind === "task" &&
      hero.item.text === t.text && hero.item.path === t.path &&
      hero.item.line === t.line;

    const nonHero = allTasks.filter((t) => !isHeroTask(t));
    const overdue = nonHero.filter((t) => t.dueDate !== null && t.dueDate < date);
    const dueToday = nonHero.filter((t) => t.dueDate !== null && t.dueDate === date);
    const open = nonHero.filter((t) => t.dueDate === null || t.dueDate > date);

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
      // Reduce available label width by the extra indent to keep total ≤ taskWidth.
      const effectiveWidth = taskWidth - indent;
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
      lines.push(`  ${g} ${indentStr}${label}${inlineTail}${originTail}`);
    };

    const CLUSTER_MIN = 3;
    const OVERDUE_CAP = 6;
    const TODAY_CAP = 4;
    const OPEN_CAP = 4;
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
    const openShown = section("OPEN", open, OPEN_CAP, "plain");

    // Honest overflow using the view's TRUE totals (counts.*), not the received
    // (possibly display-capped) arrays. Overdue is reported exactly (the verdict
    // header already relies on the received list carrying all overdue); every
    // other non-shown task folds into a single "more" so the math never lies.
    const heroIsTask = hero !== null && hero.kind === "task";
    const trueTotal = (counts.openTasks + followupsTotal) - (heroIsTask ? 1 : 0);
    const overdueMore = Math.max(0, overdue.length - overdueShown);
    const otherMore = Math.max(0, (trueTotal - overdue.length) - (todayShown + openShown));
    if (overdueMore > 0 || otherMore > 0) {
      const parts: string[] = [];
      if (overdueMore > 0) parts.push(`${overdueMore} more overdue`);
      if (otherMore > 0) parts.push(`${otherMore} more`);
      lines.push(`  ${paint(`… ${parts.join(" · ")} · dome today --verbose`, "muted", caps)}`);
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
