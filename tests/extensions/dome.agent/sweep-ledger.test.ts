import { describe, expect, test } from "bun:test";

import {
  parseSweepLedger,
  renderSweepRun,
  upsertCursor,
  type SweepDisposition,
  type SweepSettlement,
} from "../../../assets/extensions/dome.agent/lib/sweep-ledger";

const LEDGER = [
  "# Sweep ledger",
  "",
  "cursor:: 2026-06-08",
  "",
  "## Run 2026-06-09",
  "",
  "- [[wiki/dailies/2026-06-08]] -> [[wiki/entities/alice-henshaw]] :: integrated",
  "- [[wiki/dailies/2026-06-08]] -> [[wiki/entities/tokka]] :: no-op",
  "",
].join("\n");

describe("parseSweepLedger", () => {
  test("parses cursor and settlement lines", () => {
    const parsed = parseSweepLedger(LEDGER);
    expect(parsed.cursor).toBe("2026-06-08");
    expect(parsed.settlements).toHaveLength(2);
    expect(parsed.settlements[0]).toEqual({
      material: "wiki/dailies/2026-06-08",
      destination: "wiki/entities/alice-henshaw",
      disposition: "integrated",
    });
    expect(parsed.problems).toHaveLength(0);
  });

  test("missing/empty ledger yields null cursor and no settlements", () => {
    expect(parseSweepLedger("").cursor).toBeNull();
    expect(parseSweepLedger("").settlements).toHaveLength(0);
  });

  test("parses a failed disposition", () => {
    const parsed = parseSweepLedger(
      "- [[wiki/dailies/2026-06-08]] -> [[wiki/entities/x]] :: failed\n",
    );
    expect(parsed.settlements[0]?.disposition).toBe("failed");
  });

  test("escalated disposition round-trips through renderSweepRun and the parser", () => {
    const rows: ReadonlyArray<{
      material: string;
      destination: string;
      disposition: SweepDisposition;
    }> = [
      {
        material: "wiki/dailies/2026-06-08",
        destination: "wiki/entities/x",
        disposition: "escalated",
      },
    ];
    const rendered = renderSweepRun({ date: "2026-06-09", rows });
    expect(rendered).toContain(
      "- [[wiki/dailies/2026-06-08]] -> [[wiki/entities/x]] :: escalated",
    );
    const parsed = parseSweepLedger(rendered);
    expect(parsed.problems).toHaveLength(0);
    expect(parsed.settlements).toHaveLength(1);
    expect(parsed.settlements[0]).toEqual({
      material: "wiki/dailies/2026-06-08",
      destination: "wiki/entities/x",
      disposition: "escalated",
    });
  });

  test("malformed lines degrade to problems, never throw", () => {
    const parsed = parseSweepLedger("cursor:: not-a-date\n- broken line ::\n");
    expect(parsed.cursor).toBeNull();
    expect(parsed.problems.length).toBeGreaterThan(0);
  });

  test("ignores prose, headings, and blank lines", () => {
    const parsed = parseSweepLedger("# Sweep ledger\n\nsome prose note\n");
    expect(parsed.problems).toHaveLength(0);
  });
});

describe("renderSweepRun / upsertCursor", () => {
  test("appends a run section and round-trips through the parser", () => {
    const rows: ReadonlyArray<{
      material: string;
      destination: string;
      disposition: SweepDisposition;
    }> = [
      { material: "wiki/dailies/2026-06-09", destination: "wiki/entities/x", disposition: "integrated" },
      { material: "wiki/dailies/2026-06-09", destination: "wiki/entities/y", disposition: "no-op" },
    ];
    const next = upsertCursor(
      `${LEDGER}\n${renderSweepRun({ date: "2026-06-10", rows })}`,
      "2026-06-09",
    );
    const parsed = parseSweepLedger(next);
    expect(parsed.cursor).toBe("2026-06-09");
    expect(parsed.settlements).toHaveLength(4);
  });

  test("upsertCursor replaces an existing cursor line in place and creates one when absent", () => {
    expect(parseSweepLedger(upsertCursor("", "2026-06-10")).cursor).toBe("2026-06-10");
    const replaced = upsertCursor(LEDGER, "2026-06-10");
    expect(parseSweepLedger(replaced).cursor).toBe("2026-06-10");
    expect(replaced.match(/^cursor::/gm)).toHaveLength(1);
  });

  // --- new hardening tests ---

  test("upsertCursor collapses duplicate cursor lines to exactly one with the new date", () => {
    const twoLines = [
      "# Sweep ledger",
      "",
      "cursor:: 2026-06-01",
      "",
      "cursor:: 2026-06-08",
      "",
      "## Run 2026-06-08",
      "",
    ].join("\n");
    const result = upsertCursor(twoLines, "2026-06-10");
    expect(result.match(/^cursor::/gm)).toHaveLength(1);
    expect(parseSweepLedger(result).cursor).toBe("2026-06-10");
  });

  test("parseSweepLedger treats an impossible date as a problem, not a cursor", () => {
    const parsed = parseSweepLedger("cursor:: 2026-13-45\n");
    expect(parsed.cursor).toBeNull();
    expect(parsed.problems).toHaveLength(1);
  });

  test("upsertCursor append path produces exactly one blank line before cursor::", () => {
    const result = upsertCursor("# L\n\nprose\n", "2026-06-10");
    expect(result).toContain("prose\n\ncursor::");
    expect(result).not.toContain("prose\n\n\ncursor::");
  });
});

// ----- runs array (Task 6 addition) -----------------------------------------

const MULTI_RUN_LEDGER = [
  "# Sweep ledger",
  "",
  "cursor:: 2026-06-09",
  "",
  "## Run 2026-06-08",
  "",
  "- [[wiki/dailies/2026-06-07]] -> [[wiki/entities/alice-henshaw]] :: integrated",
  "- [[wiki/dailies/2026-06-07]] -> [[wiki/entities/tokka]] :: no-op",
  "",
  "## Run 2026-06-09",
  "",
  "- [[wiki/dailies/2026-06-08]] -> [[wiki/entities/bob-chen]] :: questioned",
  "- [[wiki/dailies/2026-06-08]] -> [[wiki/entities/tokka]] :: failed",
  "",
].join("\n");

describe("parseSweepLedger runs array", () => {
  test("parses two run sections with their rows", () => {
    const parsed = parseSweepLedger(MULTI_RUN_LEDGER);
    expect(parsed.runs).toHaveLength(2);
    expect(parsed.runs[0]?.date).toBe("2026-06-08");
    expect(parsed.runs[0]?.rows).toHaveLength(2);
    expect(parsed.runs[1]?.date).toBe("2026-06-09");
    expect(parsed.runs[1]?.rows).toHaveLength(2);
  });

  test("runs rows match the flat settlements list (same objects)", () => {
    const parsed = parseSweepLedger(MULTI_RUN_LEDGER);
    // All run rows together should equal the full settlements list
    const allRunRows: SweepSettlement[] = [];
    for (const run of parsed.runs) allRunRows.push(...run.rows);
    expect(allRunRows).toEqual([...parsed.settlements]);
  });

  test("rows before any ## Run heading appear in settlements but not in runs", () => {
    const withDateless = [
      "# Sweep ledger",
      "",
      "cursor:: 2026-06-08",
      "",
      // dateless settlement — before any ## Run heading
      "- [[wiki/dailies/2026-06-07]] -> [[wiki/entities/x]] :: integrated",
      "",
      "## Run 2026-06-09",
      "",
      "- [[wiki/dailies/2026-06-08]] -> [[wiki/entities/y]] :: no-op",
      "",
    ].join("\n");
    const parsed = parseSweepLedger(withDateless);
    // Both rows are in settlements
    expect(parsed.settlements).toHaveLength(2);
    // Only the run-section row is in runs
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]?.rows).toHaveLength(1);
    expect(parsed.runs[0]?.rows[0]?.destination).toBe("wiki/entities/y");
  });

  test("empty ledger yields empty runs array", () => {
    expect(parseSweepLedger("").runs).toHaveLength(0);
    expect(parseSweepLedger("").runs).toEqual([]);
  });

  test("a run section with no rows has an empty rows array", () => {
    const ledger = [
      "## Run 2026-06-09",
      "",
      "## Run 2026-06-10",
      "",
      "- [[wiki/dailies/2026-06-09]] -> [[wiki/entities/x]] :: integrated",
      "",
    ].join("\n");
    const parsed = parseSweepLedger(ledger);
    expect(parsed.runs).toHaveLength(2);
    expect(parsed.runs[0]?.rows).toHaveLength(0);
    expect(parsed.runs[1]?.rows).toHaveLength(1);
  });

  test("runs are in document order", () => {
    const parsed = parseSweepLedger(MULTI_RUN_LEDGER);
    const dates = parsed.runs.map((r) => r.date);
    expect(dates).toEqual(["2026-06-08", "2026-06-09"]);
  });

  test("round-trips: renderSweepRun output parsed into runs correctly", () => {
    const rows: ReadonlyArray<SweepSettlement> = [
      { material: "wiki/dailies/2026-06-09", destination: "wiki/entities/x", disposition: "integrated" },
      { material: "wiki/dailies/2026-06-09", destination: "wiki/entities/y", disposition: "questioned" },
    ];
    const ledger = `# Sweep ledger\n\ncursor:: 2026-06-08\n${renderSweepRun({ date: "2026-06-10", rows })}`;
    const parsed = parseSweepLedger(ledger);
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]?.date).toBe("2026-06-10");
    expect(parsed.runs[0]?.rows).toHaveLength(2);
    expect(parsed.runs[0]?.rows[0]?.disposition).toBe("integrated");
    expect(parsed.runs[0]?.rows[1]?.disposition).toBe("questioned");
  });

  test("backward compatibility: settlements is still a flat list across all runs", () => {
    const parsed = parseSweepLedger(MULTI_RUN_LEDGER);
    // integrated + no-op from run 2026-06-08, questioned + failed from 2026-06-09
    expect(parsed.settlements).toHaveLength(4);
    expect(parsed.settlements.map((s) => s.disposition)).toEqual([
      "integrated", "no-op", "questioned", "failed",
    ]);
  });
});
