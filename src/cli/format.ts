// cli/format: output formatters for the Phase 9 CLI commands.
//
// Two formatters:
//   - `formatTable(rows)`: render a `Record<string, unknown>[]` as a
//     fixed-column-width text table. Columns are derived from the union
//     of all row keys (insertion-ordered by first appearance).
//   - `formatJson(value)`: pretty-print arbitrary values as JSON.
//
// Phase 9's commands print to stdout via `console.log`. These formatters
// return strings; the command handler writes them. Keeping them pure
// makes them trivially unit-testable.
//
// Empty-input semantics:
//   - `formatTable([])` returns the literal "(no rows)" — matches the
//     "empty-table message on a fresh vault" assertion in the Phase 9
//     `dome doctor` smoke test.

// ----- formatTable ----------------------------------------------------------

/**
 * Render rows as a simple text table. Columns are the union of keys
 * across all rows; each column is padded to the max width of its
 * values (or the column header, whichever is longer). Values are
 * stringified via `stringifyCell` — strings pass through; null /
 * undefined render as "-"; everything else passes through
 * `String(...)`.
 *
 * Format:
 *
 *   ```
 *   col1  col2  col3
 *   ----  ----  ----
 *   val   val   val
 *   ```
 *
 * Empty rows render as "(no rows)" so a fresh-vault `dome doctor` view
 * doesn't print a header-only table.
 */
export function formatTable(
  rows: ReadonlyArray<Record<string, unknown>>,
): string {
  if (rows.length === 0) return "(no rows)";

  // Derive columns: ordered by first appearance across rows.
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        cols.push(key);
      }
    }
  }

  // Compute per-column max width.
  const widths: Record<string, number> = {};
  for (const c of cols) widths[c] = c.length;
  for (const row of rows) {
    for (const c of cols) {
      const cell = stringifyCell(row[c]);
      const cur = widths[c] ?? 0;
      if (cell.length > cur) widths[c] = cell.length;
    }
  }

  const pad = (s: string, n: number): string =>
    s.length >= n ? s : s + " ".repeat(n - s.length);

  const headerLine = cols.map((c) => pad(c, widths[c] ?? 0)).join("  ");
  const sepLine = cols.map((c) => "-".repeat(widths[c] ?? 0)).join("  ");
  const bodyLines = rows.map((row) =>
    cols.map((c) => pad(stringifyCell(row[c]), widths[c] ?? 0)).join("  "),
  );

  return [headerLine, sepLine, ...bodyLines].join("\n");
}

// ----- formatJson -----------------------------------------------------------

/**
 * Pretty-print a value as JSON with 2-space indent. The returned string
 * has no trailing newline; the caller's `console.log` adds one.
 *
 * Note: this passes through to `JSON.stringify` and will throw on
 * circular references — that's a programmer error, not a runtime case.
 */
export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ----- internals ------------------------------------------------------------

/**
 * Stringify a cell value for table rendering. Null / undefined render
 * as "-" (the conventional CLI placeholder); strings pass through;
 * everything else goes through `String(...)`. JSON-stringifies objects
 * and arrays so they render on one line within the table.
 */
function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // Object / array — JSON-stringify so the row stays on one line.
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
