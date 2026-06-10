// assets/extensions/dome.agent/lib/sweep-queue.ts
// The deterministic spine of the nightly sweep (design Approach B): plain
// code decides WHAT must be integrated; the model only decides how to phrase
// one page's integration. Pure — files in, ranked capped queue out. No clock,
// no model, no I/O. Uses Date.UTC arithmetic for timezone-safe date math.

import { type ParsedSweepLedger } from "./sweep-ledger";

// ----- Public types ---------------------------------------------------------

export type SweepQueueItem = {
  readonly material: string;     // vault path with .md
  readonly destination: string;  // vault path with .md
  readonly mentions: number;
  readonly materialDate: string; // YYYY-MM-DD
  readonly failedCount: number;  // prior `failed` ledger rows for this pair
};

export type SweepQueue = {
  readonly items: ReadonlyArray<SweepQueueItem>;
  readonly dropped: number;      // beyond-cap count (re-queued next night)
};

// ----- Date helpers ---------------------------------------------------------

/** Parse a YYYY-MM-DD string to a UTC epoch in ms (deterministic, no TZ). */
function isoToUtcMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

/** Return YYYY-MM-DD for (today − days) using Date.UTC arithmetic. */
function isoDateMinusDays(today: string, days: number): string {
  const ms = isoToUtcMs(today) - days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

// ----- Material discovery ---------------------------------------------------

const DAILY_RE = /^wiki\/dailies\/(\d{4}-\d{2}-\d{2})\.md$/;
const INBOX_RE = /^inbox\/processed\/(\d{4}-\d{2}-\d{2})/;

type MaterialEntry = { path: string; date: string };

function discoverMaterial(
  list: ReadonlyArray<string>,
  today: string,
  windowDays: number,
  cursor: string | null,
): MaterialEntry[] {
  const floor = isoDateMinusDays(today, windowDays);
  const result: MaterialEntry[] = [];
  for (const path of list) {
    let date: string | null = null;
    const dm = DAILY_RE.exec(path);
    if (dm?.[1]) date = dm[1];
    else {
      const im = INBOX_RE.exec(path);
      if (im?.[1]) date = im[1];
    }
    if (date === null) continue;
    // Window: floor <= date < today (yesterday inclusive, today exclusive)
    if (date < floor || date >= today) continue;
    // Cursor narrows: if a cursor exists, skip material on or before it
    if (cursor !== null && date <= cursor) continue;
    result.push({ path, date });
  }
  return result;
}

// ----- Wikilink targets -----------------------------------------------------

const WIKILINK_RE = /\[\[([^\]|#]+)/g;

/** Normalise a raw wikilink target to a vault path (append .md when absent). */
function normaliseLinkTarget(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
}

function wikilinkDestinations(
  body: string,
  list: ReadonlyArray<string>,
  targets: ReadonlyArray<string>,
): Set<string> {
  const set = new Set<string>();
  const listSet = new Set(list);
  let match: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((match = WIKILINK_RE.exec(body)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    const path = normaliseLinkTarget(raw);
    if (!listSet.has(path)) continue;
    if (targets.some((prefix) => path.startsWith(prefix))) {
      set.add(path);
    }
  }
  return set;
}

// ----- Title mentions -------------------------------------------------------

/** Derive display title from a vault path: basename minus .md, hyphens/underscores → spaces. */
function titleFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/, "").replace(/[-_]/g, " ");
}

function titleMentionDestinations(
  body: string,
  list: ReadonlyArray<string>,
  targets: ReadonlyArray<string>,
): Set<string> {
  const set = new Set<string>();
  const lowerBody = body.toLowerCase();
  for (const path of list) {
    if (!targets.some((prefix) => path.startsWith(prefix))) continue;
    const title = titleFromPath(path);
    if (title.length < 4) continue;
    if (lowerBody.includes(title.toLowerCase())) {
      set.add(path);
    }
  }
  return set;
}

// ----- Settlement checks ----------------------------------------------------

/**
 * Return true when the destination's frontmatter `sources:` block already
 * contains a wikilink to the material (without .md suffix). We do a cheap
 * frontmatter slice (lines between the leading `---` pair) — no YAML parse.
 */
function isSettledBySources(destContent: string, materialWithoutMd: string): boolean {
  const lines = destContent.split(/\r?\n/);
  let inFrontmatter = false;
  let fmDashCount = 0;
  let inSourcesBlock = false;

  for (const line of lines) {
    if (fmDashCount === 0 && line.trimEnd() === "---") {
      inFrontmatter = true;
      fmDashCount = 1;
      continue;
    }
    if (fmDashCount === 1 && line.trimEnd() === "---") {
      // End of frontmatter
      break;
    }
    if (!inFrontmatter) break;

    // Track whether we are inside the sources: block (YAML list)
    if (/^sources:/.test(line)) {
      inSourcesBlock = true;
    } else if (inSourcesBlock && /^\S/.test(line)) {
      // A new top-level key ends the sources block
      inSourcesBlock = false;
    }

    if (inSourcesBlock && line.includes(`[[${materialWithoutMd}]]`)) {
      return true;
    }
  }
  return false;
}

// ----- Ledger settlement / failed count -------------------------------------

type LedgerInfo = { settled: boolean; failedCount: number };

function ledgerInfo(
  ledger: ParsedSweepLedger,
  materialWithoutMd: string,
  destWithoutMd: string,
): LedgerInfo {
  let settled = false;
  let failedCount = 0;
  for (const row of ledger.settlements) {
    if (row.material === materialWithoutMd && row.destination === destWithoutMd) {
      if (row.disposition === "integrated" || row.disposition === "no-op" || row.disposition === "questioned") {
        settled = true;
      } else if (row.disposition === "failed") {
        failedCount += 1;
      }
    }
  }
  return { settled, failedCount };
}

// ----- Mention count --------------------------------------------------------

/**
 * Count wikilink mentions of a path in body (multiple occurrences of the same
 * wikilink count individually). Also adds 1 for each case-insensitive title
 * occurrence beyond a bare wikilink hit. The total drives rank (higher =
 * more salient).
 */
function countMentions(body: string, destPath: string): number {
  // Count wikilinks
  let count = 0;
  const withoutMd = destPath.endsWith(".md") ? destPath.slice(0, -3) : destPath;
  const wikilinkTarget = withoutMd;
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const wikilinkRe = /\[\[([^\]|#]+)/g;
  while ((m = wikilinkRe.exec(body)) !== null) {
    const raw = m[1]?.trim() ?? "";
    const normalised = raw.endsWith(".md") ? raw.slice(0, -3) : raw;
    if (normalised === wikilinkTarget) count += 1;
  }
  // Add title occurrences (case-insensitive includes)
  const title = titleFromPath(destPath);
  if (title.length >= 4) {
    const lowerBody = body.toLowerCase();
    const lowerTitle = title.toLowerCase();
    let idx = 0;
    while ((idx = lowerBody.indexOf(lowerTitle, idx)) !== -1) {
      count += 1;
      idx += lowerTitle.length;
    }
  }
  return count;
}

// ----- Main function --------------------------------------------------------

export function buildSweepQueue(opts: {
  readonly list: ReadonlyArray<string>;
  readonly read: (path: string) => string | null;
  readonly ledger: ParsedSweepLedger;
  readonly today: string;        // YYYY-MM-DD (engine clock, ctx.now())
  readonly windowDays: number;
  readonly targets: ReadonlyArray<string>; // path prefixes
  readonly maxItems: number;
}): SweepQueue {
  const { list, read, ledger, today, windowDays, targets, maxItems } = opts;

  const material = discoverMaterial(list, today, windowDays, ledger.cursor);

  // Build the set of daily paths so we never include a daily as a destination
  const dailyPaths = new Set(list.filter((p) => DAILY_RE.test(p)));

  const candidates: SweepQueueItem[] = [];

  for (const mat of material) {
    const body = read(mat.path);
    if (body === null) continue;

    // Collect all destinations (wikilink + title mention), union
    const wikilinkDests = wikilinkDestinations(body, list, targets);
    const titleDests = titleMentionDestinations(body, list, targets);
    const allDests = new Set([...wikilinkDests, ...titleDests]);

    // Remove self and dailies
    allDests.delete(mat.path);
    for (const dp of dailyPaths) allDests.delete(dp);

    const materialWithoutMd = mat.path.endsWith(".md")
      ? mat.path.slice(0, -3)
      : mat.path;

    for (const dest of allDests) {
      const destWithoutMd = dest.endsWith(".md") ? dest.slice(0, -3) : dest;

      // Settlement by sources frontmatter
      const destContent = read(dest) ?? "";
      if (isSettledBySources(destContent, materialWithoutMd)) continue;

      // Settlement by ledger (failed does NOT settle)
      const li = ledgerInfo(ledger, materialWithoutMd, destWithoutMd);
      if (li.settled) continue;

      const mentions = countMentions(body, dest);

      candidates.push(Object.freeze({
        material: mat.path,
        destination: dest,
        mentions,
        materialDate: mat.date,
        failedCount: li.failedCount,
      }));
    }
  }

  // Rank: materialDate desc, mentions desc, destination asc (total determinism)
  candidates.sort((a, b) => {
    if (a.materialDate > b.materialDate) return -1;
    if (a.materialDate < b.materialDate) return 1;
    if (b.mentions !== a.mentions) return b.mentions - a.mentions;
    return a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0;
  });

  const dropped = Math.max(0, candidates.length - maxItems);
  const items = Object.freeze(candidates.slice(0, maxItems));

  return Object.freeze({ items, dropped });
}
