// engine/host/health/daily: daily-edition probe + duplicate-task-anchor scan +
// commit-signing finding + the cron/brief/date helpers they share.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nextFire, parseCron } from "../../operational/cron";
import { parseBlockAnchor } from "../../../core/block-anchor";
import { findAllGeneratedBlocks } from "../../../core/generated-block";
import {
  fencedCodeBlockLineRanges,
  frontmatterLineRange,
  type LineRange,
} from "../../../core/markdown-scan";
import { compareStrings } from "../../../core/compare";
import type { LedgerDb } from "../../../ledger/db";
import { queryRunSummaries } from "../../../ledger/runs";
import type { ProcessorRegistry } from "../../../processors/registry";
import type { HealthFinding } from "./types";

export function dailyEditionFindings(opts: {
  readonly now: Date;
  /**
   * The brief's manifest cron expression; null when `dome.agent.brief` is
   * not enabled/loaded (both probes stay silent).
   */
  readonly briefCron: string | null;
  /**
   * Distinct local dates (YYYY-MM-DD, newest first) on which the run ledger
   * records a `dome.agent.brief` run of any status — a failed run still
   * proves the scheduler fired (failures are `run.latest-problem`'s job).
   */
  readonly briefRunDates: ReadonlyArray<string>;
  /** Whether `sources/calendar/<date>.md` exists in the vault working tree. */
  readonly calendarFileExists: (date: string) => boolean;
}): ReadonlyArray<HealthFinding> {
  if (opts.briefCron === null) return Object.freeze([]);
  const findings: HealthFinding[] = [];

  const today = formatLocalDate(opts.now);
  const scheduledTimePassedToday = cronFiredToday(opts.briefCron, opts.now);
  if (
    scheduledTimePassedToday &&
    opts.briefRunDates.length > 0 &&
    !opts.briefRunDates.includes(today)
  ) {
    findings.push(
      Object.freeze({
        code: "daily.edition-not-compiled" as const,
        severity: "warning" as const,
        subject: "daily" as const,
        id: "dome.agent.brief" as const,
        message:
          `dome.agent.brief was scheduled today (cron "${opts.briefCron}") ` +
          `and the scheduled time has passed, but the run ledger has no ` +
          `brief run for ${today} — this morning's edition was not compiled.`,
        recovery:
          "Check that `dome serve` is running (scheduled processors fire " +
          "only while the host runs) and review this report's model-provider " +
          "findings; then run `dome sync --json` and re-run `dome doctor`.",
        daily: Object.freeze({ date: today, cron: opts.briefCron }),
      }),
    );
  }

  const recentRunDates = opts.briefRunDates.slice(0, 2);
  if (
    recentRunDates.length === 2 &&
    recentRunDates.every((date) => !opts.calendarFileExists(date))
  ) {
    findings.push(
      Object.freeze({
        code: "daily.calendar-source-missing" as const,
        severity: "info" as const,
        subject: "daily" as const,
        id: "calendar_source" as const,
        message:
          `No sources/calendar/<date>.md existed for the morning brief's ` +
          `last 2 run days (${recentRunDates.join(", ")}); the edition's ` +
          `meetings section was omitted both mornings.`,
        recovery:
          "Enable the dome.sources calendar subscription (config + a " +
          ".dome/bin fetch command — see docs/wiki/specs/sources.md) or " +
          "wire a vault-side fetcher that commits sources/calendar/<date>.md " +
          "before the brief (docs/wiki/specs/vault-layout.md §\"Populating " +
          "the calendar file\"). A deliberately calendar-less vault may " +
          "ignore this info finding.",
        daily: Object.freeze({
          briefRunDates: Object.freeze([...recentRunDates]),
        }),
      }),
    );
  }

  return Object.freeze(findings);
}

// ----- Task-anchor integrity probe -------------------------------------------

export type TaskAnchorScanFile = {
  readonly path: string;
  readonly content: string;
};

export type TaskAnchorOccurrence = {
  readonly path: string;
  readonly line: number;
  readonly text: string;
};

export type TaskAnchorCollision = {
  readonly anchor: string;
  readonly occurrences: ReadonlyArray<TaskAnchorOccurrence>;
};

const TASK_ANCHOR_RE = /^t[0-9A-Za-z][A-Za-z0-9-]*$/;
const TASK_ANCHOR_SCAN_IGNORED_DIRS = new Set([
  ".git",
  ".dome",
  ".Codex",
  "node_modules",
]);
const DAILY_ORIGIN_TASK_EXCLUDED_BLOCKS: ReadonlyArray<{
  readonly owner: string;
  readonly block: string;
}> = Object.freeze([
  Object.freeze({ owner: "dome.daily", block: "start-context" }),
  Object.freeze({ owner: "dome.daily", block: "open-loops" }),
  Object.freeze({ owner: "dome.daily", block: "carried-forward" }),
  Object.freeze({ owner: "dome.daily", block: "close" }),
  Object.freeze({ owner: "dome.agent.brief", block: "yesterday" }),
]);

export function duplicateTaskAnchorFindings(opts: {
  readonly files: ReadonlyArray<TaskAnchorScanFile>;
}): ReadonlyArray<HealthFinding> {
  const collisions = duplicateTaskAnchorCollisions(opts);
  return Object.freeze(
    collisions.map((collision) =>
      Object.freeze({
        code: "task.duplicate-anchor" as const,
        severity: "warning" as const,
        subject: "tasks" as const,
        id: collision.anchor,
        message:
          `Task anchor ^${collision.anchor} appears on ` +
          `${collision.occurrences.length} origin task lines; ` +
          "carried-forward close propagation is ambiguous until all but one " +
          "line gets a new task anchor.",
        recovery:
          "Run `dome repair task-anchors --dry-run` to inspect the proposed " +
          "repair, then `dome repair task-anchors --apply` to remove duplicate " +
          "anchors from non-kept origin lines. Run `dome sync` afterward so " +
          "dome.daily.stamp-block-id assigns fresh identities.",
        taskAnchor: Object.freeze({
          anchor: collision.anchor,
          occurrences: collision.occurrences,
        }),
      }),
    ),
  );
}

export function duplicateTaskAnchorCollisions(opts: {
  readonly files: ReadonlyArray<TaskAnchorScanFile>;
}): ReadonlyArray<TaskAnchorCollision> {
  const byAnchor = new Map<string, TaskAnchorOccurrence[]>();
  for (const file of opts.files) {
    for (const occurrence of taskAnchorOccurrences(file)) {
      const occurrences = byAnchor.get(occurrence.anchor) ?? [];
      occurrences.push(
        Object.freeze({
          path: file.path,
          line: occurrence.line,
          text: occurrence.text,
        }),
      );
      byAnchor.set(occurrence.anchor, occurrences);
    }
  }

  const collisions: TaskAnchorCollision[] = [];
  for (const [anchor, occurrences] of [...byAnchor.entries()].sort((a, b) =>
    compareStrings(a[0], b[0]),
  )) {
    if (occurrences.length < 2) continue;
    collisions.push(
      Object.freeze({
        anchor,
        occurrences: Object.freeze([...occurrences]),
      }),
    );
  }
  return Object.freeze(collisions);
}

export function taskAnchorOccurrences(file: TaskAnchorScanFile): ReadonlyArray<{
  readonly anchor: string;
  readonly line: number;
  readonly text: string;
}> {
  const lines = file.content.split(/\r?\n/);
  const ignored = taskAnchorIgnoredRanges(file.content);
  const out: Array<{ anchor: string; line: number; text: string }> = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = idx + 1;
    if (lineIsInsideRanges(line, ignored)) continue;
    const raw = lines[idx] ?? "";
    const parsed = parseBlockAnchor(raw);
    if (parsed === null || !TASK_ANCHOR_RE.test(parsed.id)) continue;
    if (!isOriginTaskLikeLine(parsed.withoutAnchor)) continue;
    out.push(Object.freeze({ anchor: parsed.id, line, text: raw.trim() }));
  }
  return Object.freeze(out);
}

export function taskAnchorIgnoredRanges(content: string): ReadonlyArray<LineRange> {
  const frontmatter = frontmatterLineRange(content);
  const ranges: LineRange[] = [
    ...fencedCodeBlockLineRanges(content),
    ...(frontmatter === null ? [] : [frontmatter]),
  ];
  for (const block of DAILY_ORIGIN_TASK_EXCLUDED_BLOCKS) {
    for (const range of findAllGeneratedBlocks(
      content,
      block.owner,
      block.block,
    )) {
      ranges.push(Object.freeze({ start: range.startLine, end: range.endLine }));
    }
  }
  return Object.freeze(ranges);
}

export function isOriginTaskLikeLine(lineWithoutAnchor: string): boolean {
  if (/\s+\(from \[\[[^\]\n]+\]\]\)\s*$/.test(lineWithoutAnchor)) {
    return false;
  }
  if (/^\s*[-*]\s+\[[ xX-]\]\s+\S/.test(lineWithoutAnchor)) return true;
  return /^\s*(?:[-*]\s+)?(?:todo|follow[- ]?up)\s*:\s*\S/i.test(
    lineWithoutAnchor,
  );
}

export function lineIsInsideRanges(
  line: number,
  ranges: ReadonlyArray<LineRange>,
): boolean {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

export function markdownFilesForTaskAnchorScan(
  vaultPath: string,
): ReadonlyArray<TaskAnchorScanFile> {
  const out: TaskAnchorScanFile[] = [];
  walkMarkdownFiles(vaultPath, "", out);
  return Object.freeze(out.sort((a, b) => compareStrings(a.path, b.path)));
}

export function walkMarkdownFiles(
  root: string,
  relDir: string,
  out: TaskAnchorScanFile[],
): void {
  const absDir = relDir === "" ? root : join(root, relDir);
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (TASK_ANCHOR_SCAN_IGNORED_DIRS.has(entry.name)) continue;
      walkMarkdownFiles(
        root,
        relDir === "" ? entry.name : `${relDir}/${entry.name}`,
        out,
      );
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
    try {
      out.push(
        Object.freeze({
          path: relPath,
          content: readFileSync(join(root, relPath), "utf8"),
        }),
      );
    } catch {
      // A disappearing/unreadable markdown file should not make doctor fail.
    }
  }
}

/**
 * The `git.commit-signing` info finding (the day-one GPG hazard from the
 * second-user ledger): the vault's effective git config — usually the
 * inherited global config — enables commit signing. Dome's own commit
 * paths are immune (engine adoption commits and `dome capture` go through
 * isomorphic-git, which never invokes gpg; the shipped dome.sources fetch
 * templates commit with `git -c commit.gpgsign=false`), so this is purely
 * informational: it names the still-affected paths (the owner's own
 * `git commit` and any custom vault-side script shelling plain
 * `git commit`) instead of letting a non-interactive signing failure
 * surface as a mystery later.
 */
export function commitSigningFinding(): HealthFinding {
  return Object.freeze({
    code: "git.commit-signing" as const,
    severity: "info" as const,
    subject: "git" as const,
    id: "commit_gpgsign" as const,
    message:
      "This vault's effective git config sets commit.gpgsign=true (often " +
      "inherited from the global config). Dome's own commit paths are " +
      "immune — engine adoption commits and `dome capture` use " +
      "isomorphic-git (which never invokes gpg), and the shipped " +
      "dome.sources fetch templates commit with `git -c " +
      "commit.gpgsign=false`. Affected: your own `git commit` and any " +
      "custom vault-side script that shells out to plain `git commit` — " +
      "those will try to sign, and a missing key or absent agent fails " +
      "the commit non-interactively.",
    recovery:
      "Informational — signing your own commits is your call. If an " +
      "unattended script's commits fail on signing, add `-c " +
      "commit.gpgsign=false` to its git commit invocation, or run " +
      "`git config --local commit.gpgsign false` in the vault to keep " +
      "human commits unsigned here too.",
  });
}

/**
 * True when `cron`'s earliest fire of the local day containing `now` is at
 * or before `now`. Malformed expressions return false (manifest crons are
 * validated upstream; a probe never throws).
 */
export function cronFiredToday(cron: string, now: Date): boolean {
  let parsed;
  try {
    parsed = parseCron(cron);
  } catch {
    return false;
  }
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // nextFire scans from `after + 1 minute`, so back off one minute to make
  // 00:00 itself eligible.
  const firstFire = nextFire(
    parsed,
    new Date(startOfDay.getTime() - 60_000),
  );
  return (
    formatLocalDate(firstFire) === formatLocalDate(now) &&
    firstFire.getTime() <= now.getTime()
  );
}

/** The brief's schedule cron from the loaded registry, if any. */
export function briefScheduleCron(registry: ProcessorRegistry): string | null {
  const brief = registry.get("dome.agent.brief");
  if (brief === undefined) return null;
  for (const trigger of brief.triggers) {
    if (trigger.kind === "schedule") return trigger.cron;
  }
  return null;
}

/**
 * Distinct local run dates (YYYY-MM-DD, newest first) for `dome.agent.brief`
 * from the run ledger. Bounded read — the probe needs at most the two most
 * recent days plus today.
 */
export function briefRunDates(ledger: LedgerDb): ReadonlyArray<string> {
  const rows = queryRunSummaries(ledger, {
    processorId: "dome.agent.brief",
    limit: 50,
  });
  const dates: string[] = [];
  for (const row of rows) {
    const startedAt = new Date(row.startedAt);
    if (Number.isNaN(startedAt.getTime())) continue;
    const date = formatLocalDate(startedAt);
    if (!dates.includes(date)) dates.push(date);
  }
  return Object.freeze(dates);
}

export function formatLocalDate(date: Date): string {
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

