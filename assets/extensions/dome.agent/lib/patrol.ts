// dome.agent.patrol — pure selector + renderers for the deterministic
// staleness patrol (product-review-3 Task 15).
//
// The garden processor (processors/patrol.ts) is thin wiring around these pure
// functions (the edition-blocks pattern): scan the wiki, hand the candidates
// here, render the two meta files, diff-before-emit. Everything in this module
// is a pure function of its inputs — no clock, no I/O — so the rendered files
// are byte-deterministic per (candidate set, ledger, today) and the processor's
// no-op guard can trust an exact string compare.
//
// Two files, two roles:
//   - meta/patrol-queue.md   — tonight's pick (≤ QUEUE_LIMIT stalest eligible
//     pages), a FULL rewrite each night. Consolidate (Task 16) consumes it.
//   - meta/patrol-ledger.md  — the visit record: one line per queued page,
//     bounded to the trailing RETENTION_DAYS on every render
//     ([[wiki/invariants/NO_ACCRETING_REGISTRIES]]). Its 35-day window is what
//     keeps the patrol from re-queuing the same page night after night.

import { frontmatterLineRange } from "../../../../src/core/markdown-scan";
import { compareStrings } from "../../../../src/core/compare";

/** The two patrol-owned meta files (defaults; both are full rewrites). */
export const PATROL_QUEUE_PATH = "meta/patrol-queue.md";
export const PATROL_LEDGER_PATH = "meta/patrol-ledger.md";

/** Path prefixes the patrol scans for staleness + oversize. */
export const PATROL_SCAN_PREFIXES: ReadonlyArray<string> = Object.freeze([
  "wiki/entities/",
  "wiki/concepts/",
  "wiki/syntheses/",
]);

/** Tonight's queue is capped at the 5 stalest eligible pages. */
export const QUEUE_LIMIT = 5;
/** A page queued within this many days is not re-queued (revisit window). */
export const REVISIT_DAYS = 35;
/** Visits older than this many days are pruned from the ledger. */
export const RETENTION_DAYS = 60;
/** A scanned page longer than this earns the propose-split nudge. */
export const OVERSIZED_LINES = 600;

const QUEUE_TITLE = "# Patrol queue";
const QUEUE_CONTRACT =
  "_Tonight's consolidate reviews these pages; a clean bill or a proposal, then they leave the queue._";
const QUEUE_EMPTY =
  "_No pages are due for patrol — every scanned page has been groomed within the last 35 days._";
const LEDGER_TITLE = "# Patrol ledger";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A staleness candidate: a scanned page carrying an `updated:` date. */
export type PatrolCandidate = {
  /** Wikilink target — the vault path with any `.md` suffix stripped. */
  readonly page: string;
  /** Frontmatter `updated:` date, normalized to `YYYY-MM-DD`. */
  readonly updated: string;
  /** Current line count (rides the queue bullet, never an identity). */
  readonly lineCount: number;
};

/** One recorded patrol visit: the night a page was queued. */
export type PatrolVisit = {
  readonly date: string; // YYYY-MM-DD
  readonly page: string; // wikilink target (no `.md`)
};

// ----- Scanning helpers (pure) ----------------------------------------------

/** Strip a trailing `.md` from a vault path (the wikilink target form). */
export function withoutMd(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}

/**
 * Count the lines in a document. A single trailing newline yields a phantom
 * empty final element from the split; it is not counted, so the number matches
 * what an editor reports.
 */
export function countLines(content: string): number {
  if (content === "") return 0;
  const parts = content.split(/\r?\n/);
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    return parts.length - 1;
  }
  return parts.length;
}

/**
 * Extract the frontmatter `updated:` date, normalized to `YYYY-MM-DD`, or
 * `null` when the page has no terminated frontmatter, no `updated:` key, or an
 * unparseable value. Pages without a usable date are skipped by the selector
 * (documented: staleness is `updated:`-driven).
 */
export function extractUpdated(content: string): string | null {
  const range = frontmatterLineRange(content);
  if (range === null) return null;
  const lines = content.split(/\r?\n/);
  // range is 1-indexed inclusive: opener at index range.start-1, closer at
  // index range.end-1; the body is the array slice between them.
  for (let i = range.start; i <= range.end - 2; i += 1) {
    const m = /^updated:\s*(.+?)\s*$/.exec(lines[i] ?? "");
    if (m === null) continue;
    const raw = m[1]!.replace(/^["']|["']$/g, "").trim();
    return normalizeDate(raw);
  }
  return null;
}

function normalizeDate(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/** Signed whole-day distance `today - date` (positive when date is in the past). */
function daysAgo(today: string, date: string): number {
  return Math.round(
    (Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${date}T00:00:00.000Z`)) /
      MS_PER_DAY,
  );
}

// ----- Ledger read side ------------------------------------------------------

const LEDGER_LINE_RE = /^- (\d{4}-\d{2}-\d{2}) \[\[([^\]]+)\]\]\s*$/;

/**
 * Parse the ledger's visit lines (`- <YYYY-MM-DD> [[<page>]]`). Non-matching
 * lines (title, blanks, hand-edits) are ignored — the ledger is advisory
 * bookkeeping, so a malformed line degrades to "not a visit" rather than
 * throwing.
 */
export function parsePatrolLedger(content: string): ReadonlyArray<PatrolVisit> {
  const visits: PatrolVisit[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = LEDGER_LINE_RE.exec(line);
    if (m === null) continue;
    visits.push(Object.freeze({ date: m[1]!, page: m[2]! }));
  }
  return Object.freeze(visits);
}

/** Most recent visit date per page, across all recorded visits. */
export function lastVisitByPage(
  visits: ReadonlyArray<PatrolVisit>,
): ReadonlyMap<string, string> {
  const latest = new Map<string, string>();
  for (const v of visits) {
    const cur = latest.get(v.page);
    if (cur === undefined || compareStrings(v.date, cur) > 0) {
      latest.set(v.page, v.date);
    }
  }
  return latest;
}

// ----- Queue read side (the consolidate consumer, Task 16) -------------------

const QUEUE_LINE_RE = /^- \[\[([^\]]+)\]\]/;

/**
 * Parse the queue file's page bullets (`- [[<page>]] — last updated …`) into
 * their wikilink targets, in file order. Non-bullet lines (the title, the
 * contract header, the empty-state line, blanks, hand-typed notes) are ignored
 * — the queue is advisory input the consolidate agent reviews, so a malformed
 * or empty file degrades to "no queued pages" rather than throwing. A missing
 * file's caller passes `""`, which parses to the empty list.
 */
export function parsePatrolQueue(content: string): ReadonlyArray<string> {
  const pages: string[] = [];
  const seen = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const m = QUEUE_LINE_RE.exec(line);
    if (m === null) continue;
    const page = m[1]!.trim();
    if (page.length === 0 || seen.has(page)) continue;
    seen.add(page);
    pages.push(page);
  }
  return Object.freeze(pages);
}

// ----- Selection -------------------------------------------------------------

/**
 * The stalest eligible candidates, oldest `updated:` first (tiebreak page asc),
 * capped at `limit`. A candidate whose most recent visit is within
 * `revisitDays` of `today` is excluded — that page was groomed recently and
 * should not re-queue until the window lapses.
 */
export function selectStalest(opts: {
  readonly candidates: ReadonlyArray<PatrolCandidate>;
  readonly lastVisit: ReadonlyMap<string, string>;
  readonly today: string;
  readonly revisitDays: number;
  readonly limit: number;
}): ReadonlyArray<PatrolCandidate> {
  const eligible = opts.candidates.filter((c) => {
    const visited = opts.lastVisit.get(c.page);
    if (visited === undefined) return true;
    return daysAgo(opts.today, visited) >= opts.revisitDays;
  });
  return Object.freeze(
    [...eligible]
      .sort((a, b) => {
        const byDate = compareStrings(a.updated, b.updated);
        return byDate !== 0 ? byDate : compareStrings(a.page, b.page);
      })
      .slice(0, Math.max(0, opts.limit)),
  );
}

// ----- Renderers -------------------------------------------------------------

/**
 * Render the full queue file: the contract header plus one bullet per selected
 * page (`- [[<page>]] — last updated <date>, <n> lines`), or the fixed
 * empty-state line when nothing is due. Ends with a single trailing newline.
 */
export function renderPatrolQueue(
  selected: ReadonlyArray<PatrolCandidate>,
): string {
  const lines = [QUEUE_TITLE, "", QUEUE_CONTRACT, ""];
  if (selected.length === 0) {
    lines.push(QUEUE_EMPTY);
  } else {
    for (const c of selected) {
      const noun = c.lineCount === 1 ? "line" : "lines";
      lines.push(
        `- [[${c.page}]] — last updated ${c.updated}, ${c.lineCount} ${noun}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Render the full ledger file: the existing visits (pruned to the trailing
 * `retentionDays`) plus tonight's visit for each `selectedPages` entry, deduped
 * by `(date, page)` and sorted newest-first (tiebreak page asc). Ends with a
 * single trailing newline. Full rewrite each night — bounded, never accreting.
 */
export function renderPatrolLedger(opts: {
  readonly existingVisits: ReadonlyArray<PatrolVisit>;
  readonly selectedPages: ReadonlyArray<string>;
  readonly today: string;
  readonly retentionDays: number;
}): string {
  const kept = opts.existingVisits.filter(
    (v) => daysAgo(opts.today, v.date) < opts.retentionDays,
  );
  const merged = new Map<string, PatrolVisit>();
  for (const v of kept) merged.set(`${v.date} ${v.page}`, v);
  for (const page of opts.selectedPages) {
    const v = { date: opts.today, page };
    merged.set(`${v.date} ${v.page}`, v);
  }
  const sorted = [...merged.values()].sort((a, b) => {
    const byDate = compareStrings(b.date, a.date); // newest first
    return byDate !== 0 ? byDate : compareStrings(a.page, b.page);
  });
  const lines = [LEDGER_TITLE, ""];
  for (const v of sorted) lines.push(`- ${v.date} [[${v.page}]]`);
  return `${lines.join("\n")}\n`;
}
