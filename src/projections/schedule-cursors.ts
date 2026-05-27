// projection-schedule-cursors: per-table accessor for cron-scheduled
// processor cursors. Tracks last-fire / next-fire times per processor so the
// engine's scheduler can decide whether a `schedule` trigger should fire.
//
// Normative references:
//   - docs/wiki/specs/projection-store.md §"Tables — schedule_cursors"
//     (column shape; replaces v0.5's `.dome/state/scheduled.json` JSON file)
//
// The at-most-once-per-sync clamp for missed intervals (per the spec's
// reference to docs/wiki/gotchas/scheduled-hook-idempotency) is NOT enforced
// at this layer — it's a property of how the engine's scheduler reads + writes
// these cursors (set `last_fire` to "now", not the missed-interval time).
// This file just persists rows.
//
// House-style notes (matches src/projections/db.ts, src/projections/facts.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - No JSON columns on this table — every field is a plain TEXT scalar.
//   - Returned arrays are `Object.freeze`'d.
//   - `noUncheckedIndexedAccess` discipline: indexed reads from `.all()`
//     check `=== undefined` before reading.

import type { ProjectionDb } from "./db";

// ----- Public types ---------------------------------------------------------

export type ScheduleCursor = {
  readonly processorId: string;
  readonly cron: string;
  /** ISO-8601 timestamp of the last time the schedule fired. */
  readonly lastFire: string;
  /** ISO-8601 timestamp of the next fire (computed from cron + lastFire). */
  readonly nextFire: string;
};

// ----- SQL ------------------------------------------------------------------

const UPSERT_CURSOR_SQL = `
INSERT INTO schedule_cursors (processor_id, cron, last_fire, next_fire)
VALUES (?, ?, ?, ?)
ON CONFLICT (processor_id) DO UPDATE SET
  cron = excluded.cron,
  last_fire = excluded.last_fire,
  next_fire = excluded.next_fire
`.trim();

const GET_CURSOR_SQL = `
SELECT processor_id, cron, last_fire, next_fire
FROM schedule_cursors
WHERE processor_id = ?
`.trim();

const ALL_CURSORS_SQL = `
SELECT processor_id, cron, last_fire, next_fire
FROM schedule_cursors
ORDER BY processor_id
`.trim();

// ----- Row shape ------------------------------------------------------------

type CursorRow = {
  readonly processor_id: string;
  readonly cron: string;
  readonly last_fire: string;
  readonly next_fire: string;
};

// ----- Public functions -----------------------------------------------------

/**
 * Upsert a cursor for the given processor. If a row exists, every field is
 * overwritten with the supplied values; if no row exists, a new row is
 * inserted. The processor's id is the PRIMARY KEY.
 *
 * Throws on SQLite-level failure (disk full).
 */
export function upsertCursor(db: ProjectionDb, cursor: ScheduleCursor): void {
  db.raw.query(UPSERT_CURSOR_SQL).run(
    cursor.processorId,
    cursor.cron,
    cursor.lastFire,
    cursor.nextFire,
  );
}

/**
 * Read the cursor for a single processor. Returns `null` if no cursor has
 * been persisted (the processor has never fired, or the row was wiped by a
 * rebuild).
 */
export function getCursor(
  db: ProjectionDb,
  processorId: string,
): ScheduleCursor | null {
  const rows = db.raw
    .query<CursorRow, [string]>(GET_CURSOR_SQL)
    .all(processorId);
  const r = rows[0];
  if (r === undefined) return null;
  return rowToCursor(r);
}

/**
 * Read every cursor. Returns a frozen array; ordering is by `processor_id`
 * (stable, lexicographic).
 */
export function allCursors(db: ProjectionDb): ReadonlyArray<ScheduleCursor> {
  const rows = db.raw.query<CursorRow, []>(ALL_CURSORS_SQL).all();
  return Object.freeze(rows.map(rowToCursor));
}

// ----- internals ------------------------------------------------------------

function rowToCursor(row: CursorRow): ScheduleCursor {
  return Object.freeze({
    processorId: row.processor_id,
    cron: row.cron,
    lastFire: row.last_fire,
    nextFire: row.next_fire,
  });
}
