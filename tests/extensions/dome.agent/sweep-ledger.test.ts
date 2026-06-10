import { describe, expect, test } from "bun:test";

import {
  parseSweepLedger,
  renderSweepRun,
  upsertCursor,
  type SweepDisposition,
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
