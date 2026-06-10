// assets/extensions/dome.agent/lib/sweep-ledger.ts
// The advisory sweep ledger: committed markdown carrying the scan cursor,
// settlement lines, and per-run sections the brief digest renders. Advisory
// means correctness never depends on it alone — "integrated" settlement is
// authoritative in the destination's sources: frontmatter; the ledger's
// no-op/questioned lines only save re-judging, and "failed" rows never
// settle (they count toward the escalate-after-3 contract). Strict grammar,
// degrade on malformed lines (problems, never throws) — mirrors
// preferences-shared.

export type SweepDisposition = "integrated" | "no-op" | "questioned" | "failed";

export type SweepSettlement = {
  readonly material: string;
  readonly destination: string;
  readonly disposition: SweepDisposition;
};

export type ParsedSweepLedger = {
  readonly cursor: string | null; // YYYY-MM-DD
  readonly settlements: ReadonlyArray<SweepSettlement>;
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
  /^-\s+\[\[([^\]]+)\]\]\s+->\s+\[\[([^\]]+)\]\]\s+::\s+(integrated|no-op|questioned|failed)\s*$/;

export function parseSweepLedger(content: string): ParsedSweepLedger {
  let cursor: string | null = null;
  const settlements: SweepSettlement[] = [];
  const problems: string[] = [];
  for (const [i, raw] of content.split(/\r?\n/).entries()) {
    const line = raw.trimEnd();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (CURSOR_LINE_RE.test(line)) {
      const match = CURSOR_RE.exec(line);
      if (match?.[1] !== undefined && isValidDate(match[1])) cursor = match[1];
      else problems.push(`line ${i + 1}: malformed cursor line`);
      continue;
    }
    if (line.startsWith("- ") && line.includes("::")) {
      const match = SETTLEMENT_RE.exec(line);
      if (match !== null) {
        settlements.push(Object.freeze({
          material: match[1] ?? "",
          destination: match[2] ?? "",
          disposition: match[3] as SweepDisposition,
        }));
      } else {
        problems.push(`line ${i + 1}: malformed settlement line`);
      }
      continue;
    }
    // Prose and other bullets are ignored (the run summary may carry notes).
  }
  return Object.freeze({
    cursor,
    settlements: Object.freeze(settlements),
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
