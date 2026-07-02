// assets/extensions/dome.agent/lib/sweep-ledger.ts
// The advisory sweep ledger's WRITER helpers: `renderSweepRun` (append a run
// section) and `upsertCursor` (advance the scan cursor). The pure read-side
// grammar — `SweepDisposition`, `SweepSettlement`, `SweepRun`,
// `ParsedSweepLedger`, `parseSweepLedger` — moved to
// `dome.daily/processors/sweep-ledger.ts` (the sanctioned cross-bundle import
// direction is dome.agent -> dome.daily; precedent: EDITION_YESTERDAY_BLOCK
// in daily-types.ts) so dome.daily's compose-blocks processor can read the
// ledger without dome.daily depending on dome.agent. Only dome.agent's sweep
// processor writes the ledger, so these two helpers stay here.

import {
  CURSOR_LINE_RE,
  type SweepSettlement,
} from "../../dome.daily/processors/sweep-ledger";

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
