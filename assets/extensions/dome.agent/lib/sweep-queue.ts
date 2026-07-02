// assets/extensions/dome.agent/lib/sweep-queue.ts
// The deterministic spine of the nightly sweep (design Approach B): plain
// code decides WHAT must be integrated; the model only decides how to phrase
// one page's integration. Pure — files in, ranked capped queue out. No clock,
// no model, no I/O. Uses Date.UTC arithmetic for timezone-safe date math.
//
// CURSOR CONTRACT: the processor must advance the cursor only to
//   min(yesterday, dayBefore(oldestUnswept), dayBefore(oldest failed-tonight materialDate))
// — never past material whose pairs were dropped or failed tonight.
// The windowDays floor is the eventual decay backstop: even if dropped material
// goes unprocessed for many nights, the window floor eventually ages it out.
// Use the exported `safeCursor` helper to compute this value.

import { type ParsedSweepLedger } from "../../dome.daily/processors/sweep-ledger";

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
  /** Count of candidates beyond the cap — these pairs will be eligible again
   * on subsequent runs *as long as the cursor is held back to before their
   * materialDate* (see module doc and `safeCursor`). The windowDays floor is
   * the eventual decay backstop. Re-queueing is NOT automatic if the processor
   * advances the cursor past the dropped material's date. */
  readonly dropped: number;
  /** Earliest materialDate among CAP-DROPPED pairs, or null when nothing was
   * dropped. The processor must not advance the cursor past dayBefore(this). */
  readonly oldestUnswept: string | null;
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

/** Return the ISO date one day before the given date. */
function dayBefore(date: string): string {
  return isoDateMinusDays(date, 1);
}

// ----- Safe cursor helper ---------------------------------------------------

/**
 * Compute the safe cursor value the processor should store after a run.
 * The cursor must not advance past any material whose pairs were dropped
 * (beyond cap) or failed tonight — otherwise those pairs will never be
 * revisited (the `date <= cursor` exclusion in discoverMaterial will skip them).
 *
 * Returns min(yesterday, dayBefore(oldestUnswept), dayBefore(oldestFailed))
 * where any null terms are treated as infinity (not constraining).
 */
export function safeCursor(opts: {
  today: string;
  oldestUnswept: string | null;
  oldestFailed: string | null;
}): string {
  const { today, oldestUnswept, oldestFailed } = opts;
  let result = dayBefore(today); // yesterday
  if (oldestUnswept !== null) {
    const candidate = dayBefore(oldestUnswept);
    if (candidate < result) result = candidate;
  }
  if (oldestFailed !== null) {
    const candidate = dayBefore(oldestFailed);
    if (candidate < result) result = candidate;
  }
  return result;
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
  const re = /\[\[([^\]|#]+)/g;
  while ((match = re.exec(body)) !== null) {
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

// ----- Wikilink short-link (basename only) destinations --------------------

/**
 * Also match short-link wikilinks of the form [[alice-henshaw]] (bare basename,
 * no path prefix) against the full vault list. Obsidian resolves these by
 * basename uniqueness; we replicate that: if exactly one path in list has this
 * basename (without .md) and it is under a target prefix, add it.
 */
function shortlinkDestinations(
  body: string,
  list: ReadonlyArray<string>,
  targets: ReadonlyArray<string>,
): Set<string> {
  const set = new Set<string>();
  // Build a basename → paths map for target pages
  const basenameMap = new Map<string, string[]>();
  for (const path of list) {
    if (!targets.some((prefix) => path.startsWith(prefix))) continue;
    const base = path.split("/").pop()?.replace(/\.md$/, "") ?? "";
    if (!basenameMap.has(base)) basenameMap.set(base, []);
    basenameMap.get(base)!.push(path);
  }

  const re = /\[\[([^\]|#/]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const candidates = basenameMap.get(raw);
    if (candidates && candidates.length === 1) {
      set.add(candidates[0]!);
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

/** Escape regex metacharacters in a literal string. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary title match: a title is considered mentioned only when it is
 * not immediately preceded or followed by a lowercase letter or digit.
 * This prevents "earn" matching "learned", "robin" matching "Robinhood", etc.
 */
function titleMentionDestinations(
  body: string,
  list: ReadonlyArray<string>,
  targets: ReadonlyArray<string>,
): Set<string> {
  const set = new Set<string>();
  for (const path of list) {
    if (!targets.some((prefix) => path.startsWith(prefix))) continue;
    const title = titleFromPath(path);
    if (title.length < 4) continue;
    const pattern = new RegExp(
      `(?<![a-z0-9])${escapeRegex(title)}(?![a-z0-9])`,
      "i",
    );
    if (pattern.test(body)) {
      set.add(path);
    }
  }
  return set;
}

// ----- Settlement checks ----------------------------------------------------

/**
 * Single source of truth for the four wikilink forms that count as a
 * settlement link to `materialWithoutMd` on one line:
 *   [[material]]              (exact)
 *   [[material|display text]] (display-text alias)
 *   [[material.md]]           (.md suffix)
 *   [[material.md|display]]   (both)
 *
 * Shared by `isSettledBySources` (the queue's settlement scan) and the sweep
 * processor's deterministic settlement guarantee (`ensureSourcesLink`), so
 * detection and enforcement can never accept different forms — a drift that
 * would otherwise double-add or wrongly skip a settlement record.
 */
export function lineHasMaterialLink(
  line: string,
  materialWithoutMd: string,
): boolean {
  const withMd = `${materialWithoutMd}.md`;
  return (
    line.includes(`[[${materialWithoutMd}]]`) ||
    line.includes(`[[${materialWithoutMd}|`) ||
    line.includes(`[[${withMd}]]`) ||
    line.includes(`[[${withMd}|`)
  );
}

/**
 * Return true when the destination's frontmatter `sources:` block already
 * contains a wikilink to the material (any of the four forms accepted by
 * {@link lineHasMaterialLink}).
 *
 * We do a cheap frontmatter slice (lines between the leading `---` pair) — no
 * YAML parse. Leading blank lines before the opening `---` are tolerated.
 */
function isSettledBySources(destContent: string, materialWithoutMd: string): boolean {
  const lines = destContent.split(/\r?\n/);
  let inFrontmatter = false;
  let fmDashCount = 0;
  let inSourcesBlock = false;

  for (const line of lines) {
    // Skip leading blank lines before the opening ---
    if (fmDashCount === 0 && !inFrontmatter && line.trim() === "") continue;

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

    if (inSourcesBlock && lineHasMaterialLink(line, materialWithoutMd)) {
      return true;
    }
  }
  return false;
}

// ----- Ledger settlement / failed count -------------------------------------

type LedgerInfo = { settled: boolean; failedCount: number };

/**
 * Ledger-derived settlement. `integrated` rows deliberately do NOT settle:
 * for an integration the destination's `sources:` wikilink (written
 * atomically with the integration patch) is the authoritative record — the
 * ledger row is redundant when the link landed and exactly wrong when the
 * integration's sub-proposal was rejected (the row would suppress the
 * re-queue forever). `no-op`/`questioned` rows settle (they only save
 * re-judging); `failed` rows never settle and count toward escalation;
 * `escalated` rows settle terminally — the pair stops consuming attempts
 * and stops holding the cursor back, and becomes eligible again only when
 * the owner hand-deletes the escalated row from the ledger.
 */
function ledgerInfo(
  ledger: ParsedSweepLedger,
  materialWithoutMd: string,
  destWithoutMd: string,
): LedgerInfo {
  let settled = false;
  let failedCount = 0;
  for (const row of ledger.settlements) {
    if (row.material === materialWithoutMd && row.destination === destWithoutMd) {
      if (
        row.disposition === "no-op" ||
        row.disposition === "questioned" ||
        row.disposition === "escalated"
      ) {
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
 * wikilink count individually). Also adds 1 for each word-boundary-matched
 * title occurrence beyond a bare wikilink hit. The total drives rank (higher =
 * more salient).
 */
function countMentions(body: string, destPath: string): number {
  // Count wikilinks
  let count = 0;
  const withoutMd = destPath.endsWith(".md") ? destPath.slice(0, -3) : destPath;
  const wikilinkTarget = withoutMd;
  let m: RegExpExecArray | null;
  const wikilinkRe = /\[\[([^\]|#]+)/g;
  while ((m = wikilinkRe.exec(body)) !== null) {
    const raw = m[1]?.trim() ?? "";
    const normalised = raw.endsWith(".md") ? raw.slice(0, -3) : raw;
    if (normalised === wikilinkTarget) count += 1;
  }
  // Add title occurrences using word-boundary matching (case-insensitive)
  const title = titleFromPath(destPath);
  if (title.length >= 4) {
    const pattern = new RegExp(
      `(?<![a-z0-9])${escapeRegex(title)}(?![a-z0-9])`,
      "gi",
    );
    while (pattern.exec(body) !== null) {
      count += 1;
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

    // Collect all destinations (wikilink + short-link + title mention), union
    const wikilinkDests = wikilinkDestinations(body, list, targets);
    const shortlinkDests = shortlinkDestinations(body, list, targets);
    const titleDests = titleMentionDestinations(body, list, targets);
    const allDests = new Set([...wikilinkDests, ...shortlinkDests, ...titleDests]);

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

  const droppedCandidates = candidates.slice(maxItems);
  const dropped = droppedCandidates.length;
  const items = Object.freeze(candidates.slice(0, maxItems));

  // oldestUnswept: earliest materialDate among the dropped candidates
  let oldestUnswept: string | null = null;
  for (const c of droppedCandidates) {
    if (oldestUnswept === null || c.materialDate < oldestUnswept) {
      oldestUnswept = c.materialDate;
    }
  }

  return Object.freeze({ items, dropped, oldestUnswept });
}
