// proposals/db: the pending-proposals store's connection lifecycle, schema
// definition, and schema-hash bookkeeping. This file is the SQLite boundary
// for `proposals.db`, parallel to how `src/ledger/db.ts` is the boundary
// for the run ledger and `src/answers/db.ts` is the boundary for durable
// question answers.
//
// A garden-phase processor's `PatchEffect` under `mode: "propose"` captures
// an LLM's judgment call made at a specific point in time against a specific
// candidate tree. That judgment is not rebuildable by re-running the
// processor — a fresh garden run may reach a different conclusion, or may
// not run again at all before the owner reviews the original proposal — so
// once a proposal is enqueued it must survive projection rebuilds and
// outbox-schema migrations. Like the run ledger, this store holds
// unrebuildable operational decisions: schema-hash mismatches REFUSE rather
// than wipe (`policy: { kind: "refuse" }`; see `src/sqlite/open-store.ts`
// for the shared refuse/migrate seam this store opens through).
//
// Per-row accessors (enqueue, list, get, decide) live in
// `src/proposals/pending-proposals.ts`; this file owns only the schema +
// open lifecycle, mirroring the split between `src/ledger/db.ts` and
// `src/ledger/runs.ts`.

import { Database } from "bun:sqlite";

import { type Result, ok, err } from "../types";
import { type SqliteTableShape } from "../sqlite-shape";
import { computeDdlHash } from "../sqlite/hash";
import { openSimpleStore, type StoreOpenError } from "../sqlite/open-store";

// ----- Schema DDL ------------------------------------------------------------
//
// The canonical DDL. Order matters for schema-hash determinism — changing
// the order changes the hash, which `openProposalsDb` treats as a schema
// change. The hash is sha256 of the joined statements; see
// `computeProposalsSchemaHash` below.

const DDL: ReadonlyArray<string> = Object.freeze([
  "CREATE TABLE IF NOT EXISTS proposals_meta ("
    + "schema_hash TEXT NOT NULL PRIMARY KEY,"
    + "built_at TEXT NOT NULL"
    + ")",
  "CREATE TABLE IF NOT EXISTS pending_proposals ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    + "dedupe_key TEXT NOT NULL UNIQUE,"
    + "processor_id TEXT NOT NULL,"
    + "extension_id TEXT NOT NULL,"
    + "run_id TEXT,"
    + "reason TEXT NOT NULL,"
    + "changes_json TEXT NOT NULL,"
    + "source_refs_json TEXT NOT NULL,"
    + "base_commit TEXT NOT NULL,"
    + "base_contents_json TEXT NOT NULL,"
    + "created_at TEXT NOT NULL,"
    + "status TEXT NOT NULL DEFAULT 'pending',"
    + "decided_at TEXT, decided_by TEXT, applied_commit TEXT, note TEXT"
    + ")",
  "CREATE INDEX IF NOT EXISTS pending_proposals_by_status ON pending_proposals(status, created_at)",
]);

const REQUIRED_TABLE_SHAPES: ReadonlyArray<SqliteTableShape> = Object.freeze([
  {
    table: "proposals_meta",
    columns: ["schema_hash", "built_at"],
  },
  {
    table: "pending_proposals",
    columns: [
      "id",
      "dedupe_key",
      "processor_id",
      "extension_id",
      "run_id",
      "reason",
      "changes_json",
      "source_refs_json",
      "base_commit",
      "base_contents_json",
      "created_at",
      "status",
      "decided_at",
      "decided_by",
      "applied_commit",
      "note",
    ],
  },
]);

// ----- Public types -----------------------------------------------------------

/**
 * Opaque handle to the pending-proposals database. `schemaHash` is captured
 * at open time; the schema is immutable for the lifetime of the handle, so
 * the value is safe to memoize. `close()` is idempotent per Bun's
 * `sqlite3_close_v2` semantics.
 */
export type ProposalsDb = {
  readonly raw: Database;
  readonly schemaHash: string;
  readonly close: () => void;
};

export type OpenProposalsDbOpts = {
  /**
   * Absolute filesystem path to the proposals.db file. Caller computes
   * `<vault>/.dome/state/proposals.db`; this file is vault-layout-agnostic
   * by design, mirroring `src/ledger/db.ts` / `src/answers/db.ts`.
   */
  readonly path: string;
};

/**
 * The two migration states the caller branches on — REFUSE policy never
 * yields a third "migrated" state (see `src/ledger/db.ts` for the same
 * narrowing).
 *
 * - `"fresh"` — db file didn't exist (or was empty); schema created;
 *   `proposals_meta` row inserted with the current schema_hash.
 * - `"ok"`    — schema hash matches the stored value; existing
 *   `pending_proposals` rows survive untouched.
 */
export type ProposalsMigration = "fresh" | "ok";

export type OpenProposalsDbResult = {
  readonly db: ProposalsDb;
  readonly migration: ProposalsMigration;
};

/** Proposals refuse on mismatch; their open errors are exactly the shared seam's. */
export type ProposalsDbError = StoreOpenError;

/**
 * sha256 of the canonical DDL string (statements joined by "\n"). Pure —
 * same DDL produces the same hash on every call.
 */
export function computeProposalsSchemaHash(): string {
  return computeDdlHash(DDL);
}

/**
 * Open (or create) the pending-proposals database at `opts.path`. Ensures
 * the parent directory exists, applies the schema if missing, and refuses
 * schema-hash mismatches without mutating the file.
 *
 * The function never throws on expected I/O failures — the conditions
 * (directory create, DDL apply, meta read) all surface as `Result.err`.
 * Programmer bugs (e.g., a logic error in this file) can still throw.
 */
export async function openProposalsDb(
  opts: OpenProposalsDbOpts,
): Promise<Result<OpenProposalsDbResult, ProposalsDbError>> {
  // Pending proposals are unrebuildable operational decisions (see the
  // header), so policy is REFUSE on any schema-hash mismatch (never wipe).
  // The shared seam owns dir/open/hash/DDL/shapes/meta/close-on-error.
  const result = openSimpleStore({
    path: opts.path,
    metaTable: "proposals_meta",
    ddl: DDL,
    currentHash: computeProposalsSchemaHash(),
    shapes: REQUIRED_TABLE_SHAPES,
    policy: { kind: "refuse" },
  });
  if (!result.ok) return err(result.error);

  const { raw, schemaHash, migration } = result.value;
  // REFUSE policy never yields "migrated"; map onto the narrow enum.
  const proposalsMigration: ProposalsMigration =
    migration === "fresh" ? "fresh" : "ok";

  const db: ProposalsDb = Object.freeze({
    raw,
    schemaHash,
    close: () => raw.close(),
  });

  return ok(Object.freeze({ db, migration: proposalsMigration }));
}
