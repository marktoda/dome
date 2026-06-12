// assets/extensions/dome.agent/lib/sweep-ledger.ts
// The advisory sweep ledger: committed markdown carrying the scan cursor,
// settlement lines, and per-run sections the brief digest renders. Advisory
// means correctness never depends on it alone — "integrated" settlement is
// authoritative in the destination's sources: frontmatter, and the queue
// IGNORES "integrated" ledger rows entirely (the row is redundant when the
// link landed and exactly wrong when the integration's sub-proposal was
// rejected); the ledger's no-op/questioned lines only save re-judging,
// "failed" rows never settle (they count toward the escalate-after-3
// contract), and an "escalated" row is the threshold's terminal record —
// it settles the pair (queue exclusion + cursor advance) until the owner
// hand-deletes the row. Strict grammar, degrade on malformed lines
// (problems, never throws) — mirrors preferences-shared.

export type SweepDisposition =
  | "integrated"
  | "no-op"
  | "questioned"
  | "failed"
  | "escalated";

export type SweepSettlement = {
  readonly material: string;
  readonly destination: string;
  readonly disposition: SweepDisposition;
};

/**
 * A single parsed `## Run <date>` section from the ledger. Date is YYYY-MM-DD
 * (matches the `## Run` heading). Rows are the settlement lines inside that
 * section in source order.
 */
export type SweepRun = {
  readonly date: string;
  readonly rows: ReadonlyArray<SweepSettlement>;
};

export type ParsedSweepLedger = {
  readonly cursor: string | null; // YYYY-MM-DD
  /** Flat list of all settlement lines across all runs and the dateless bucket.
   * Preserved for backward compatibility — all callers that only need to check
   * whether a pair is settled use this. */
  readonly settlements: ReadonlyArray<SweepSettlement>;
  /**
   * Per-run structured view: one entry per `## Run <date>` section in the
   * ledger. Settlement lines before any `## Run` heading are excluded from this
   * array but still appear in `settlements`. Runs are in document order.
   */
  readonly runs: ReadonlyArray<SweepRun>;
  readonly problems: ReadonlyArray<string>;
};

function isValidDate(date: string): boolean {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === date;
}

const CURSOR_RE = /^cursor::\s*(\d{4}-\d{2}-\d{2})\s*$/;
const CURSOR_LINE_RE = /^cursor::/;
const SETTLEMENT_RE =
  /^-\s+\[\[([^\]]+)\]\]\s+->\s+\[\[([^\]]+)\]\]\s+::\s+(integrated|no-op|questioned|failed|escalated)\s*$/;
const RUN_HEADING_RE = /^##\s+Run\s+(\d{4}-\d{2}-\d{2})\s*$/;

export function parseSweepLedger(content: string): ParsedSweepLedger {
  let cursor: string | null = null;
  const settlements: SweepSettlement[] = [];
  const runs: SweepRun[] = [];
  const problems: string[] = [];
  // Current run accumulator: null means we are in the dateless bucket (before
  // any ## Run heading). Settlement lines in the dateless bucket appear in
  // `settlements` but not in `runs`.
  let currentRunDate: string | null = null;
  let currentRunRows: SweepSettlement[] = [];

  for (const [i, raw] of content.split(/\r?\n/).entries()) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;
    if (line.startsWith("#")) {
      // Check for ## Run <date> section headings.
      const runMatch = RUN_HEADING_RE.exec(line);
      if (runMatch?.[1] !== undefined) {
        // Flush the previous run (if any) into the runs array.
        if (currentRunDate !== null) {
          runs.push(Object.freeze({ date: currentRunDate, rows: Object.freeze(currentRunRows) }));
        }
        currentRunDate = runMatch[1];
        currentRunRows = [];
      }
      // All other headings (including # Sweep ledger) are silently ignored.
      continue;
    }
    if (CURSOR_LINE_RE.test(line)) {
      const match = CURSOR_RE.exec(line);
      if (match?.[1] !== undefined && isValidDate(match[1])) cursor = match[1];
      else problems.push(`line ${i + 1}: malformed cursor line`);
      continue;
    }
    if (line.startsWith("- ") && line.includes("::")) {
      const match = SETTLEMENT_RE.exec(line);
      if (match !== null) {
        const settlement = Object.freeze({
          material: match[1] ?? "",
          destination: match[2] ?? "",
          disposition: match[3] as SweepDisposition,
        });
        settlements.push(settlement);
        if (currentRunDate !== null) {
          currentRunRows.push(settlement);
        }
      } else {
        problems.push(`line ${i + 1}: malformed settlement line`);
      }
      continue;
    }
    // Prose and other bullets are ignored (the run summary may carry notes).
  }
  // Flush the last open run accumulator.
  if (currentRunDate !== null) {
    runs.push(Object.freeze({ date: currentRunDate, rows: Object.freeze(currentRunRows) }));
  }
  return Object.freeze({
    cursor,
    settlements: Object.freeze(settlements),
    runs: Object.freeze(runs),
    problems: Object.freeze(problems),
  });
}

export function renderSweepRun(opts: {
  readonly date: string;
  readonly rows: ReadonlyArray<SweepSettlement>;
}): string {
  const lines = opts.rows.map(
    (r) => `- [[${r.material}]] -> [[${r.destination}]] :: ${r.disposition}`,
  );
  return ["", `## Run ${opts.date}`, "", ...lines, ""].join("\n");
}

export function upsertCursor(content: string, date: string): string {
  const lines = content.split(/\r?\n/);
  const idx = lines.findIndex((l) => CURSOR_LINE_RE.test(l));
  if (idx >= 0) {
    lines[idx] = `cursor:: ${date}`;
    return lines.filter((l, i) => i === idx || !CURSOR_LINE_RE.test(l)).join("\n");
  }
  if (content.trim().length === 0) {
    return ["# Sweep ledger", "", `cursor:: ${date}`, ""].join("\n");
  }
  // Trim trailing blank lines so we always append with exactly one blank before cursor::
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.trim() === "") end--;
  return [...lines.slice(0, end), "", `cursor:: ${date}`, ""].join("\n");
}
