// Shared connection configuration for Dome's operational SQLite stores
// (projection.db, runs.db, outbox.db, answers.db).
//
// WAL is load-bearing here: a long-lived `dome serve` writer coexists with
// concurrent CLI readers (`dome status` / `check` / `inspect`) in separate
// processes. Under the default rollback journal a writer blocks readers
// (and vice versa), leaving the busy timeout to absorb routine contention;
// WAL lets readers proceed against a stable snapshot while one writer
// appends. `synchronous = NORMAL` is the standard WAL pairing: an OS crash
// can lose the most recent commits (never corrupt the file) — acceptable
// for these stores because the projection is rebuildable and the
// queue/audit stores re-derive their effects through idempotency keys and
// the next compiler tick.

import type { Database } from "bun:sqlite";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export function configureSqliteConnection(db: Database): void {
  db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  try {
    // No-op (reported as "memory") for in-memory databases used in tests.
    db.run("PRAGMA journal_mode = WAL");
  } catch {
    // The one-time DELETE→WAL transition takes an exclusive lock and can
    // return SQLITE_BUSY when two processes open the same store
    // concurrently (dome status racing dome serve's startup). The mode is
    // persistent in the file once any opener wins, so the loser proceeds
    // on the existing journal mode rather than failing the open; its next
    // open finds WAL already set.
  }
  db.run("PRAGMA synchronous = NORMAL");
}
