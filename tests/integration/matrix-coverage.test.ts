// AC3-lockstep test for matrix coverage. Asserts every bolded enforcement
// cell in docs/wiki/matrices/tool-invariant-enforcement.md maps to a test
// file at tests/invariants/<invariant-slug>.test.ts whose body mentions
// the Tool name.
//
// The matrix's bolded cells take the form `**<refusal text>**` inside
// table cells; we parse the table, identify rows (Tools) × columns
// (Invariants), and check for `**` markers.

import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const MATRIX_PATH = join(REPO_ROOT, "docs", "wiki", "matrices", "tool-invariant-enforcement.md");
const TESTS_INVARIANTS_DIR = join(REPO_ROOT, "tests", "invariants");

function invariantSlug(name: string): string {
  // RAW_IS_IMMUTABLE → raw-is-immutable
  return name.toLowerCase().replace(/_/g, "-");
}

describe("matrix-coverage (AC3-lockstep)", async () => {
  const matrixText = await readFile(MATRIX_PATH, "utf8");

  // Extract the table. The matrix has one major table; parse it.
  const tableMatch = matrixText.match(/## Matrix\n\n(\|[\s\S]+?)(?=\n##|\n$)/);
  expect(tableMatch, "Matrix file does not contain a ## Matrix section with a table").toBeDefined();
  const tableText = tableMatch![1]!;

  // Parse rows. Splitting by `|` produces a leading empty element from the
  // line's leading `|` and a trailing empty element from the trailing `|`;
  // drop both but KEEP internal empty cells (they map to "no enforcement"
  // for that Tool×Invariant pair and the column index depends on them).
  function splitRow(line: string): string[] {
    const parts = line.split("|").map(c => c.trim());
    // Drop the leading and trailing empties produced by `|` at row boundaries.
    if (parts.length > 0 && parts[0] === "") parts.shift();
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    return parts;
  }

  const lines = tableText.trim().split("\n").filter(l => l.startsWith("|"));
  expect(lines.length).toBeGreaterThan(2);
  const headerCells = splitRow(lines[0]!);
  // First cell is the Tool↓\Invariant→ legend; remaining cells are invariant names.
  const invariants = headerCells.slice(1).map(c => {
    // Strip markdown formatting: `RAW_IS_IMMUTABLE *(axiom)*` → `RAW_IS_IMMUTABLE`
    const nameMatch = c.match(/`?([A-Z_]+)`?/);
    return nameMatch ? nameMatch[1]! : "";
  });

  // For each data row, parse the row's bolded cells and emit lockstep tests.
  for (const line of lines.slice(2)) { // skip header + separator
    const cells = splitRow(line);
    if (cells.length === 0) continue;
    const toolCellRaw = cells[0]!;
    const toolMatch = toolCellRaw.match(/`([a-zA-Z]+)`/);
    if (!toolMatch) continue;
    const tool = toolMatch[1]!;

    for (let i = 1; i < cells.length && i - 1 < invariants.length; i++) {
      const cell = cells[i]!;
      const invariant = invariants[i - 1]!;
      if (invariant === "") continue;
      // Bolded enforcement = contains `**...**`
      const isBolded = /\*\*[^*]+\*\*/.test(cell);
      if (!isBolded) continue;

      test(`${tool} × ${invariant} → tests/invariants/${invariantSlug(invariant)}.test.ts mentions "${tool}"`, async () => {
        const testPath = join(TESTS_INVARIANTS_DIR, `${invariantSlug(invariant)}.test.ts`);
        expect(existsSync(testPath),
          `matrix names ${tool}×${invariant} as bolded enforcement but ${testPath} does not exist`).toBe(true);
        const testText = await readFile(testPath, "utf8");
        expect(testText.includes(tool),
          `${invariantSlug(invariant)}.test.ts must reference Tool "${tool}" (matrix cell is bolded)`).toBe(true);
      });
    }
  }
});
