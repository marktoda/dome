// sqlite-shape: non-destructive table/column validation for durable stores.

import type { Database } from "bun:sqlite";

export type SqliteTableShape = {
  readonly table: string;
  readonly columns: ReadonlyArray<string>;
};

export function validateSqliteTableShapes(
  db: Database,
  shapes: ReadonlyArray<SqliteTableShape>,
): string | null {
  for (const shape of shapes) {
    const rows = db
      .query<{ name: string }, []>(`PRAGMA table_info(${shape.table})`)
      .all();
    if (rows.length === 0) return `missing table '${shape.table}'`;
    const columns = new Set(rows.map((row) => row.name));
    for (const column of shape.columns) {
      if (!columns.has(column)) {
        return `table '${shape.table}' missing column '${column}'`;
      }
    }
  }
  return null;
}
