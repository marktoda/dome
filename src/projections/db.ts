// projection-db: the projection store's connection lifecycle, schema
// definition, and cache-key (meta) management. This file is the SQLite
// boundary for the projection layer, parallel to how `src/git.ts` is the
// codebase's single isomorphic-git boundary. Every other projection-layer
// accessor file imports the `Database` handle from this module's
// `ProjectionDb`; nothing else opens `projection.db` directly.
//
// Normative references:
//   - docs/wiki/specs/projection-store.md §"Tables", §"Cache key",
//     §"Schema migrations"
//   - docs/wiki/specs/vault-layout.md §"Derived operational state under
//     `.dome/`" — `projection.db` lives at `<vault>/.dome/state/projection.db`
//
// Structural fences this file upholds:
//   - docs/wiki/invariants/PROJECTIONS_ARE_REBUILDABLE.md — the schema-hash
//     mismatch path wipes and recreates the tables; cache-key mismatch is
//     surfaced so the engine/CLI can rebuild projections from adopted
//     markdown before stale rows are read.
//   - docs/wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH.md — `.dome/state/`
//     is explicitly derived; this file's whole concern is cache management.
//
// Mitigated gotchas:
//   - docs/wiki/gotchas/projection-schema-skew.md — auto-rebuild on
//     schema-hash mismatch (the `"schema-changed"` migration result).
//   - docs/wiki/gotchas/processor-version-drift.md — cache invalidation
//     when extension-set, processor-versions, or effective capability-policy
//     hashes change.
//
// v1 Phase 4 scope:
//   - Schema migrations are *the rebuild* (per spec §"Schema migrations").
//     This file does not implement incremental column-add migrations; it
//     wipes and recreates on schema-hash change. The DDL uses
//     `CREATE ... IF NOT EXISTS` so a fresh open on a missing file is safe.
//   - Cache-key invalidation (extension-set, processor-versions, capability
//     policy) is detected here but applied by the engine/CLI boundary. The v1
//     behavior is a full projection rebuild from the adopted commit before
//     stale rows can drive operational or view work. Per-processor
//     invalidation can be added later as an optimization without changing the
//     correctness contract.
//
// Imports (tight by design — projections are the SQLite boundary):
//   - `bun:sqlite` for the `Database` handle (the only I/O dependency).
//   - `node:fs` / `node:path` for `mkdir -p` of the parent directory.
//   - `node:crypto` for sha256 (schema hash + extension-set + processor-
//     versions hashing).
//   - `../types` for `Result<T, E>` and `ok`/`err` constructors.
//   - `../core/source-ref` for the `CommitOid` brand.
//
// No imports from `src/engine/`, `src/processors/`, or `src/core/effect`.
// Effect serialization (FactEffect → row; DiagnosticEffect → row; etc.)
// lives in the per-table accessor files that this module supports.
//
// House-style notes (matches src/engine/core/closure-commit.ts,
// src/engine/core/glob-cache.ts, src/core/source-ref.ts, src/core/effect.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - `Object.freeze` on returned handles and result objects so misbehaving
//     callers fail loudly at runtime rather than silently corrupting state.
//   - Nullable cache-key fields typed as `T | null` (not `T | undefined`)
//     so SQL NULLability maps cleanly to TS optionality under
//     `exactOptionalPropertyTypes`.
//   - `noUncheckedIndexedAccess` discipline: SQLite `.all()` returns
//     arrays; index access and check `=== undefined` before reading.
//   - All errors surface via `Result.err`; the public function never
//     throws on expected failure paths (directory-create, DDL apply,
//     meta read). Programmer bugs (e.g., null deref in our own code)
//     can still throw — `Result` is for I/O failures the caller can
//     reasonably handle.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

import { type Result, ok, err } from "../types";
import { commitOid, type CommitOid } from "../core/source-ref";
import { configureSqliteConnection } from "../sqlite/connection";

import { compareStrings } from "../core/compare";

// ----- Schema DDL -----------------------------------------------------------
//
// The canonical DDL. Order matters for schema-hash determinism — changing
// the order changes the hash, which is treated by `openProjectionDb` as a
// schema change and triggers a rebuild. The hash is sha256 of the joined
// statements (joined by "\n"); see `computeSchemaHash` below.
//
// Statements are normalized to a single canonical form (no leading/trailing
// whitespace, single spaces between tokens). This protects the hash from
// trivial whitespace edits that don't change SQL semantics. If a future
// edit reformats this constant, the hash stays stable as long as the
// canonical strings match.

const DDL: ReadonlyArray<string> = Object.freeze([
  // 1. projection_meta — the cache-key tuple + schema version.
  //    PRIMARY KEY (schema_hash) because the table holds at most one row;
  //    the schema_hash uniquely identifies the schema generation.
  "CREATE TABLE IF NOT EXISTS projection_meta ("
    + "schema_hash TEXT NOT NULL,"
    + "adopted_commit TEXT,"
    + "extension_set_hash TEXT,"
    + "processor_versions_hash TEXT,"
    + "capability_policy_hash TEXT,"
    + "built_at TEXT,"
    + "PRIMARY KEY (schema_hash)"
    + ")",

  // 2. facts — FactEffect rows. Indexed by subject (for "what do we know
  //    about this page/task/entity"), namespace (for "everything in
  //    dome.tasks"), and (namespace, predicate) (for "every dueDate").
  "CREATE TABLE IF NOT EXISTS facts ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    + "namespace TEXT NOT NULL,"
    + "subject_kind TEXT NOT NULL,"
    + "subject_id TEXT NOT NULL,"
    + "predicate TEXT NOT NULL,"
    + "object_json TEXT NOT NULL,"
    + "assertion TEXT NOT NULL,"
    + "confidence REAL,"
    + "source_refs TEXT NOT NULL,"
    + "processor_id TEXT NOT NULL,"
    + "run_id TEXT NOT NULL,"
    + "adopted_commit TEXT NOT NULL,"
    + "written_at TEXT NOT NULL"
    + ")",
  "CREATE INDEX IF NOT EXISTS facts_by_subject ON facts(subject_kind, subject_id)",
  "CREATE INDEX IF NOT EXISTS facts_by_namespace ON facts(namespace)",
  "CREATE INDEX IF NOT EXISTS facts_by_predicate ON facts(namespace, predicate)",

  // 3. fts_documents — FTS5 virtual table for markdown body search.
  //    Rows are heading-section granular (one row per H2 section, plus the
  //    `intro` section); logical identity is the (path, section_id)
  //    composite key, maintained by the projection sink (FTS5 has no UNIQUE
  //    constraints). `path`, `section_id`, `breadcrumb`, `category`, `type`,
  //    `adopted_commit` are UNINDEXED metadata (the breadcrumb is already
  //    prepended to `body` for matching); `source_refs` is UNINDEXED
  //    provenance JSON for result evidence; `title` and `body` carry the
  //    full-text content with porter+unicode61 tokenization.
  "CREATE VIRTUAL TABLE IF NOT EXISTS fts_documents USING fts5("
    + "path UNINDEXED,"
    + "section_id UNINDEXED,"
    + "breadcrumb UNINDEXED,"
    + "category UNINDEXED,"
    + "type UNINDEXED,"
    + "title,"
    + "body,"
    + "source_refs UNINDEXED,"
    + "adopted_commit UNINDEXED,"
    + "tokenize = 'porter unicode61'"
    + ")",

  // 4. diagnostics — DiagnosticEffect rows. UNIQUE (processor_id, code,
  //    proposal_id, subject_hash) dedups when a processor re-emits the
  //    same diagnostic at the same source location across retries — but
  //    lets a single processor invocation surface many distinct
  //    diagnostics (e.g., validate-wikilinks finding N broken links
  //    across different files).
  //
  //    `subject_hash` is content-based identity (path + range + stableId,
  //    excluding commit + blob) so the dedup constraint correctly
  //    collapses re-emissions across loop iterations against changing
  //    candidate trees. Provenance-based identity (hashing the full
  //    SourceRef including `commit` + `blob`) would change every
  //    iteration when the patch loop advances the candidate, causing
  //    the same diagnostic to insert twice — once anchored to the
  //    user's commit, once to the closure commit — masking the
  //    behavior the dedup constraint exists to enforce.
  //
  //    Prior shape `UNIQUE (processor_id, code, proposal_id)` (no hash)
  //    collapsed all distinct diagnostics from one processor in one
  //    proposal into a single row — masking real defects in the user's
  //    vault. The intermediate `source_refs_hash` shape (hashing the
  //    raw JSON of all SourceRef fields including commit) over-
  //    distinguished across loop iterations; the current `subject_hash`
  //    is the right granularity.
  //
  //    `proposal_id` is nullable for diagnostics not tied to a proposal
  //    (adoption-phase diagnostics emitted against the adopted ref).
  "CREATE TABLE IF NOT EXISTS diagnostics ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    + "severity TEXT NOT NULL,"
    + "code TEXT NOT NULL,"
    + "message TEXT NOT NULL,"
    + "source_refs TEXT NOT NULL,"
    + "subject_hash TEXT NOT NULL,"
    + "processor_id TEXT NOT NULL,"
    + "run_id TEXT,"
    + "proposal_id TEXT,"
    + "adopted_commit TEXT NOT NULL,"
    + "written_at TEXT NOT NULL,"
    + "resolved_at TEXT,"
    + "UNIQUE (processor_id, code, proposal_id, subject_hash)"
    + ")",

  // 5. questions — QuestionEffect rows. `idempotency_key` UNIQUE dedups
  //    retries; `metadata_json` carries optional automation policy hints;
  //    `answered_at` + `answer` are populated when the user responds.
  "CREATE TABLE IF NOT EXISTS questions ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    + "question TEXT NOT NULL,"
    + "options_json TEXT,"
    + "metadata_json TEXT,"
    + "source_refs TEXT NOT NULL,"
    + "idempotency_key TEXT NOT NULL UNIQUE,"
    + "processor_id TEXT NOT NULL,"
    + "run_id TEXT NOT NULL,"
    + "adopted_commit TEXT NOT NULL,"
    + "asked_at TEXT NOT NULL,"
    + "answered_at TEXT,"
    + "answer TEXT"
    + ")",

  // 6. scheduled_jobs — JobEffect rows for jobs with `runAfter` set.
  //    Status transitions: pending -> running -> succeeded | failed.
  "CREATE TABLE IF NOT EXISTS scheduled_jobs ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    + "processor_id TEXT NOT NULL,"
    + "input_json TEXT NOT NULL,"
    + "run_after TEXT NOT NULL,"
    + "idempotency_key TEXT NOT NULL UNIQUE,"
    + "max_attempts INTEGER NOT NULL DEFAULT 3,"
    + "attempts INTEGER NOT NULL DEFAULT 0,"
    + "status TEXT NOT NULL,"
    + "enqueued_at TEXT NOT NULL,"
    + "claimed_at TEXT,"
    + "claim_expires_at TEXT,"
    + "completed_at TEXT"
    + ")",

  // 7. schedule_cursors — last-fire / next-fire for cron-driven processors.
  //    Replaces v0.5's `.dome/state/scheduled.json` JSON file.
  "CREATE TABLE IF NOT EXISTS schedule_cursors ("
    + "processor_id TEXT NOT NULL PRIMARY KEY,"
    + "cron TEXT NOT NULL,"
    + "last_fire TEXT NOT NULL,"
    + "next_fire TEXT NOT NULL"
    + ")",
]);

// Drop order: reverse-creation. `projection_meta` is dropped last so the
// schema-version row remains queryable as long as possible during a rebuild
// (defense in depth: if a DROP somewhere in the middle throws, the meta row
// still tells the next openProjectionDb what schema it was looking at).
// FTS5 virtual tables use plain `DROP TABLE IF EXISTS` — sqlite handles the
// underlying shadow tables automatically.
const DROP_DDL: ReadonlyArray<string> = Object.freeze([
  "DROP TABLE IF EXISTS schedule_cursors",
  "DROP TABLE IF EXISTS scheduled_jobs",
  "DROP TABLE IF EXISTS questions",
  "DROP TABLE IF EXISTS diagnostics",
  "DROP TABLE IF EXISTS fts_documents",
  "DROP INDEX IF EXISTS facts_by_predicate",
  "DROP INDEX IF EXISTS facts_by_namespace",
  "DROP INDEX IF EXISTS facts_by_subject",
  "DROP TABLE IF EXISTS facts",
  "DROP TABLE IF EXISTS projection_meta",
]);

const REQUIRED_TABLE_COLUMNS: ReadonlyArray<{
  readonly table: string;
  readonly columns: ReadonlyArray<string>;
}> = Object.freeze([
  {
    table: "facts",
    columns: [
      "id",
      "namespace",
      "subject_kind",
      "subject_id",
      "predicate",
      "object_json",
      "assertion",
      "confidence",
      "source_refs",
      "processor_id",
      "run_id",
      "adopted_commit",
      "written_at",
    ],
  },
  {
    table: "fts_documents",
    columns: [
      "path",
      "section_id",
      "breadcrumb",
      "category",
      "type",
      "title",
      "body",
      "source_refs",
      "adopted_commit",
    ],
  },
  {
    table: "diagnostics",
    columns: [
      "id",
      "severity",
      "code",
      "message",
      "source_refs",
      "subject_hash",
      "processor_id",
      "run_id",
      "proposal_id",
      "adopted_commit",
      "written_at",
      "resolved_at",
    ],
  },
  {
    table: "questions",
    columns: [
      "id",
      "question",
      "options_json",
      "metadata_json",
      "source_refs",
      "idempotency_key",
      "processor_id",
      "run_id",
      "adopted_commit",
      "asked_at",
      "answered_at",
      "answer",
    ],
  },
  {
    table: "scheduled_jobs",
    columns: [
      "id",
      "processor_id",
      "input_json",
      "run_after",
      "idempotency_key",
      "max_attempts",
      "attempts",
      "status",
      "enqueued_at",
      "claimed_at",
      "claim_expires_at",
      "completed_at",
    ],
  },
  {
    table: "schedule_cursors",
    columns: ["processor_id", "cron", "last_fire", "next_fire"],
  },
  {
    table: "projection_meta",
    columns: [
      "schema_hash",
      "adopted_commit",
      "extension_set_hash",
      "processor_versions_hash",
      "capability_policy_hash",
      "built_at",
    ],
  },
]);

const PROJECTION_TABLE_NAMES = Object.freeze(
  REQUIRED_TABLE_COLUMNS.map((entry) => entry.table),
);

// ----- sha256 helper --------------------------------------------------------

const sha256 = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

// ----- Public types ---------------------------------------------------------

/**
 * The cache-key tuple + schema-version + build timestamp stored in the
 * `projection_meta` table. All cache fields are nullable (vs. the
 * spec's NOT NULL constraints) because a fresh-init projection.db has the
 * row inserted with `schema_hash` populated but the rest left null until
 * the first successful rebuild writes them. Callers that need a populated
 * meta should check for `null` and trigger the build path.
 */
export type ProjectionMeta = {
  readonly schemaHash: string;
  readonly adoptedCommit: CommitOid | null;
  readonly extensionSetHash: string | null;
  readonly processorVersionsHash: string | null;
  readonly capabilityPolicyHash: string | null;
  readonly builtAt: string | null;
};

/**
 * Opaque handle to the projection database. The raw `Database` is exposed
 * (other accessor files in `src/projections/` need it to prepare statements)
 * but it is NOT for use outside the projections layer — per
 * [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] §4, only files under
 * `src/projections/` write to projection.db.
 *
 * `meta` is a snapshot at open time. Subsequent writes to `projection_meta`
 * (e.g., by `dome rebuild` updating `built_at` + `adopted_commit`) do NOT
 * refresh this field; callers needing the live value should re-query.
 *
 * `close()` is idempotent — calling twice is a no-op per Bun's
 * `sqlite3_close_v2` semantics.
 */
export type ProjectionDb = {
  readonly raw: Database;
  readonly meta: ProjectionMeta;
  readonly close: () => void;
};

export type MarkProjectionBuiltOpts = {
  readonly adoptedCommit: CommitOid;
  readonly extensionSet: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
  }>;
  readonly processorVersions: ReadonlyArray<{
    readonly id: string;
    readonly version: string;
  }>;
  readonly capabilityPolicyHash: string;
  readonly builtAt?: Date;
};

export type ProjectionCacheKeyOpts = {
  readonly extensionSet: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
  }>;
  readonly processorVersions: ReadonlyArray<{
    readonly id: string;
    readonly version: string;
  }>;
  readonly capabilityPolicyHash: string;
};

export type ProjectionFreshnessOpts = ProjectionCacheKeyOpts & {
  readonly adoptedCommit: CommitOid;
};

export type OpenProjectionDbOpts = {
  /**
   * Absolute filesystem path to the projection.db file. Caller computes
   * `<vault>/.dome/state/projection.db`; this file is vault-layout-agnostic
   * by design (separation of concerns: the projections layer doesn't know
   * about `.dome/state/`).
   */
  readonly path: string;
  /**
   * The installed extension bundles. Hashed (sorted by name) to detect
   * adds/removes/version-bumps that should invalidate cached rows.
   */
  readonly extensionSet: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
  }>;
  /**
   * The loaded processors and their versions. Hashed (sorted by id) to
   * detect processor-version bumps that should invalidate the affected
   * rows (per [[wiki/gotchas/processor-version-drift]]).
   */
  readonly processorVersions: ReadonlyArray<{
    readonly id: string;
    readonly version: string;
  }>;
  readonly capabilityPolicyHash: string;
};

/**
 * The four migration states the caller branches on:
 *
 * - `"fresh"`              — db file didn't exist (or was empty); schema
 *                            created; `projection_meta` row inserted with
 *                            cache keys NULL. Caller should trigger a
 *                            full rebuild to populate.
 * - `"ok"`                 — schema version matches; cache keys match.
 *                            No action needed.
 * - `"schema-changed"`     — schema version differs from the stored value.
 *                            Tables wiped and recreated; meta row reset
 *                            (cache keys NULL). Caller should trigger a
 *                            full rebuild.
 * - `"cache-keys-changed"` — schema OK but at least one cache-key hash
 *                            differs from stored values. Tables are not
 *                            wiped by the opener; the engine/CLI boundary
 *                            rebuilds projections from the adopted commit
 *                            before stale rows are consumed.
 */
export type ProjectionMigration =
  | "fresh"
  | "ok"
  | "schema-changed"
  | "cache-keys-changed";

export type OpenProjectionDbResult = {
  readonly db: ProjectionDb;
  readonly migration: ProjectionMigration;
};

export type ProjectionDbError =
  | {
      readonly kind: "directory-create-failed";
      readonly path: string;
      readonly cause: string;
    }
  | {
      readonly kind: "schema-init-failed";
      readonly cause: string;
    }
  | {
      readonly kind: "meta-read-failed";
      readonly cause: string;
    };

// ----- Public hash helpers --------------------------------------------------

/**
 * sha256 of the canonical DDL string (statements joined by "\n"). Pure —
 * same DDL produces the same hash on every call. Exposed for testing and
 * for callers that want to log the schema version on startup.
 */
export function computeSchemaHash(): string {
  return sha256(DDL.join("\n"));
}

/**
 * sha256 of the sorted-by-name JSON serialization of the extension set.
 * Adding, removing, or bumping the version of any bundle changes the hash
 * and invalidates cached rows per [[wiki/specs/projection-store]] §"Cache
 * key".
 */
export function computeExtensionSetHash(
  set: ReadonlyArray<{ readonly name: string; readonly version: string }>,
): string {
  // Sort a defensive copy — we never mutate caller-owned arrays.
  const sorted = [...set].sort((a, b) => compareStrings(a.name, b.name));
  // Project to a canonical {name, version} shape so unknown extra keys on
  // the input (if any slip past TS at boundaries) don't perturb the hash.
  const canonical = sorted.map((e) => ({ name: e.name, version: e.version }));
  return sha256(JSON.stringify(canonical));
}

/**
 * sha256 of the sorted-by-id JSON serialization of the loaded processor
 * versions. Bumping a processor's version changes the hash and invalidates
 * its rows (per [[wiki/gotchas/processor-version-drift]]).
 */
export function computeProcessorVersionsHash(
  versions: ReadonlyArray<{ readonly id: string; readonly version: string }>,
): string {
  const sorted = [...versions].sort((a, b) => compareStrings(a.id, b.id));
  const canonical = sorted.map((p) => ({ id: p.id, version: p.version }));
  return sha256(JSON.stringify(canonical));
}

// ----- openProjectionDb -----------------------------------------------------

/**
 * Open (or create) the projection database at `opts.path`. Ensures the
 * parent directory exists, applies the schema if missing, and computes the
 * migration state by comparing the stored cache-key tuple against the
 * caller's current values.
 *
 * The function never throws on expected I/O failures — the four conditions
 * (directory create, DDL apply, meta read, meta insert) all surface as
 * `Result.err`. Programmer bugs (e.g., a logic error in this file) can
 * still throw.
 *
 * Side effects on success:
 *   - Parent directory of `opts.path` exists.
 *   - SQLite file at `opts.path` exists with the canonical schema applied.
 *   - `projection_meta` has exactly one row, with `schema_hash` set to the
 *     current schema hash. Cache-key columns are either:
 *       - NULL (if `migration === "fresh"` or `"schema-changed"`), or
 *       - The values from the prior open (if `migration === "ok"` or
 *         `"cache-keys-changed"`). The caller updates them via the
 *         per-table accessor files after a rebuild pass.
 */
export async function openProjectionDb(
  opts: OpenProjectionDbOpts,
): Promise<Result<OpenProjectionDbResult, ProjectionDbError>> {
  // 1. Ensure the parent directory exists. `recursive: true` makes this
  //    `mkdir -p` semantics — no error if the directory already exists.
  const parent = dirname(opts.path);
  try {
    mkdirSync(parent, { recursive: true });
  } catch (e) {
    return err({
      kind: "directory-create-failed",
      path: parent,
      cause: errorMessage(e),
    });
  }

  // 2. Open the SQLite file. Bun's Database constructor creates the file
  //    if it doesn't exist (default options: `{readwrite: true, create: true}`).
  //    A failure here is rare — corrupt file, permissions, disk full — and
  //    is surfaced as schema-init-failed (closest match in our error
  //    vocabulary; the meta-read path may also fail in similar conditions).
  let raw: Database;
  try {
    raw = new Database(opts.path);
    configureSqliteConnection(raw);
  } catch (e) {
    return err({ kind: "schema-init-failed", cause: errorMessage(e) });
  }

  // 3. Read the stored schema_hash, if any. A fresh file has no
  //    projection_meta table; we detect that by querying sqlite_master.
  //    This branch is the "fresh" path.
  const currentSchemaHash = computeSchemaHash();
  let storedSchemaHash: string | null;
  let hasExistingProjectionState: boolean;
  let schemaShapeMatches: boolean;
  try {
    storedSchemaHash = readStoredSchemaHash(raw);
    hasExistingProjectionState = projectionStateExists(raw);
    schemaShapeMatches = projectionSchemaShapeMatches(raw);
  } catch (e) {
    raw.close();
    return err({ kind: "meta-read-failed", cause: errorMessage(e) });
  }

  const isFresh = storedSchemaHash === null && !hasExistingProjectionState;
  const isSchemaChanged =
    (storedSchemaHash !== null && storedSchemaHash !== currentSchemaHash) ||
    (hasExistingProjectionState && !schemaShapeMatches);

  // 4. If schema changed, wipe everything; if fresh, just apply DDL; if
  //    matched, apply DDL idempotently (CREATE ... IF NOT EXISTS is safe
  //    and defensive against a partial schema left by a prior crash).
  try {
    if (isSchemaChanged) {
      applyDropAll(raw);
    }
    applyDdl(raw);
  } catch (e) {
    raw.close();
    return err({ kind: "schema-init-failed", cause: errorMessage(e) });
  }

  // 5. Read the existing meta row (if any) — present when we didn't wipe.
  //    On fresh or schema-changed paths, no meta row exists yet; we insert
  //    one with NULL cache keys.
  let priorMeta: ProjectionMeta | null;
  try {
    if (isFresh || isSchemaChanged) {
      insertFreshMetaRow(raw, currentSchemaHash);
      priorMeta = null;
    } else {
      priorMeta = readMetaRow(raw);
      // Defense in depth: if the meta row vanished (a process between the
      // schema-hash read above and now wiped it), fall through to insert.
      if (priorMeta === null) {
        insertFreshMetaRow(raw, currentSchemaHash);
      }
    }
  } catch (e) {
    raw.close();
    return err({ kind: "meta-read-failed", cause: errorMessage(e) });
  }

  // 6. Compute the migration state. fresh and schema-changed take precedence
  //    over cache-keys-changed because those wipe the table and the
  //    cache-key comparison would always read NULL on prior. "ok" vs
  //    "cache-keys-changed" only matters when we have a populated prior meta.
  const currentExtensionSetHash = computeExtensionSetHash(opts.extensionSet);
  const currentProcessorVersionsHash = computeProcessorVersionsHash(
    opts.processorVersions,
  );
  const currentCapabilityPolicyHash = opts.capabilityPolicyHash;

  let migration: ProjectionMigration;
  if (isFresh) {
    migration = "fresh";
  } else if (isSchemaChanged) {
    migration = "schema-changed";
  } else if (priorMeta === null) {
    // Recovered-from-missing-meta path — treat as fresh.
    migration = "fresh";
  } else if (
    priorMeta.extensionSetHash !== null &&
    priorMeta.processorVersionsHash !== null &&
    priorMeta.capabilityPolicyHash !== null &&
    (priorMeta.extensionSetHash !== currentExtensionSetHash ||
      priorMeta.processorVersionsHash !== currentProcessorVersionsHash ||
      priorMeta.capabilityPolicyHash !== currentCapabilityPolicyHash)
  ) {
    migration = "cache-keys-changed";
  } else if (
    priorMeta.extensionSetHash === null ||
    priorMeta.processorVersionsHash === null ||
    priorMeta.capabilityPolicyHash === null
  ) {
    // Prior open didn't write cache keys (rebuild incomplete). Treat as
    // fresh — the caller should do a rebuild to populate. Better signal
    // than "ok" (which implies no work to do).
    migration = "fresh";
  } else {
    migration = "ok";
  }

  // 7. Snapshot the meta for the returned handle. On fresh/schema-changed,
  //    everything but schemaHash is null (matching the just-inserted row).
  //    On ok/cache-keys-changed, the prior meta is the snapshot.
  const meta: ProjectionMeta =
    isFresh || isSchemaChanged || priorMeta === null
      ? Object.freeze({
          schemaHash: currentSchemaHash,
          adoptedCommit: null,
          extensionSetHash: null,
          processorVersionsHash: null,
          capabilityPolicyHash: null,
          builtAt: null,
        })
      : Object.freeze({
          schemaHash: currentSchemaHash,
          adoptedCommit: priorMeta.adoptedCommit,
          extensionSetHash: priorMeta.extensionSetHash,
          processorVersionsHash: priorMeta.processorVersionsHash,
          capabilityPolicyHash: priorMeta.capabilityPolicyHash,
          builtAt: priorMeta.builtAt,
        });

  const db: ProjectionDb = Object.freeze({
    raw,
    meta,
    close: () => raw.close(),
  });

  return ok(Object.freeze({ db, migration }));
}

/**
 * Wipe and recreate every table in projection.db on an already-open handle.
 * Most rows are rebuildable projections. `scheduled_jobs` and
 * `schedule_cursors` are volatile operational rows that intentionally reset
 * with the projection cache; durable answers, run history, outbox rows, and
 * quarantine state live outside this database.
 */
export function resetProjectionDb(db: ProjectionDb): void {
  applyDropAll(db.raw);
  applyDdl(db.raw);
  insertFreshMetaRow(db.raw, computeSchemaHash());
}

/**
 * Stamp the cache-key tuple after successful projection derivation: either
 * a full rebuild pass or an incremental adoption that brought projections
 * current for its changed range. This is the durable marker
 * `openProjectionDb` compares on the next open to decide whether projection
 * rows are current for the loaded bundle set.
 */
export function markProjectionBuilt(
  db: ProjectionDb,
  opts: MarkProjectionBuiltOpts,
): void {
  db.raw
    .query(
      "UPDATE projection_meta SET adopted_commit = ?, extension_set_hash = ?, "
        + "processor_versions_hash = ?, capability_policy_hash = ?, "
        + "built_at = ? WHERE schema_hash = ?",
    )
    .run(
      opts.adoptedCommit,
      computeExtensionSetHash(opts.extensionSet),
      computeProcessorVersionsHash(opts.processorVersions),
      opts.capabilityPolicyHash,
      (opts.builtAt ?? new Date()).toISOString(),
      computeSchemaHash(),
    );
}

/**
 * Return true when the live `projection_meta` row has populated cache keys
 * and at least one cache-key hash differs from the currently loaded runtime.
 * Fresh/unbuilt databases return false here:
 * callers use this as a stale-row invalidation signal, not as the first
 * build trigger for an empty projection.
 */
export function projectionCacheKeysChanged(
  db: ProjectionDb,
  opts: ProjectionCacheKeyOpts,
): boolean {
  const meta = readMetaRow(db.raw);
  if (
    meta === null ||
    meta.extensionSetHash === null ||
    meta.processorVersionsHash === null ||
    meta.capabilityPolicyHash === null
  ) {
    return false;
  }

  return (
    meta.extensionSetHash !== computeExtensionSetHash(opts.extensionSet) ||
    meta.processorVersionsHash !==
      computeProcessorVersionsHash(opts.processorVersions) ||
    meta.capabilityPolicyHash !== opts.capabilityPolicyHash
  );
}

/**
 * Return true when projection rows must be re-derived before a caller reads
 * them. Unlike `projectionCacheKeysChanged`, this treats missing/unbuilt meta
 * and adopted-commit drift as stale too. Host boundaries use this guard before
 * operational and view work consumes projection rows.
 */
export function projectionRequiresRebuild(
  db: ProjectionDb,
  opts: ProjectionFreshnessOpts,
): boolean {
  const meta = readMetaRow(db.raw);
  if (meta === null) return true;
  if (meta.adoptedCommit !== opts.adoptedCommit) return true;
  if (meta.extensionSetHash === null) return true;
  if (meta.processorVersionsHash === null) return true;
  if (meta.capabilityPolicyHash === null) return true;
  return (
    meta.extensionSetHash !== computeExtensionSetHash(opts.extensionSet) ||
    meta.processorVersionsHash !==
      computeProcessorVersionsHash(opts.processorVersions) ||
    meta.capabilityPolicyHash !== opts.capabilityPolicyHash
  );
}

// ----- internals ------------------------------------------------------------

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  // Last-resort stringification — better than `[object Object]` for the
  // error-cause string the caller surfaces in a ToolError.
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * Apply every CREATE statement in `DDL`. Idempotent — every statement uses
 * `IF NOT EXISTS`, so re-applying on an already-populated database is a
 * no-op. Wrapped in a transaction so a mid-DDL failure leaves no half-
 * created tables (sqlite rolls back).
 */
function applyDdl(db: Database): void {
  db.run("BEGIN");
  try {
    for (const stmt of DDL) {
      db.run(stmt);
    }
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}

function projectionStateExists(db: Database): boolean {
  const placeholders = PROJECTION_TABLE_NAMES.map(() => "?").join(", ");
  const rows = db
    .query<{ name: string }, string[]>(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') "
        + `AND name IN (${placeholders}) LIMIT 1`,
    )
    .all(...PROJECTION_TABLE_NAMES);
  return rows.length > 0;
}

function projectionSchemaShapeMatches(db: Database): boolean {
  for (const { table, columns } of REQUIRED_TABLE_COLUMNS) {
    const actual = tableColumns(db, table);
    if (actual === null) return false;
    for (const column of columns) {
      if (!actual.has(column)) return false;
    }
  }
  return true;
}

function tableColumns(db: Database, table: string): ReadonlySet<string> | null {
  const rows = db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all();
  if (rows.length === 0) return null;
  return new Set(rows.map((row) => row.name));
}

/**
 * Drop every table + index per `DROP_DDL`. Used on schema-hash mismatch
 * before re-applying the current DDL. Wrapped in a transaction for the same
 * reason as `applyDdl`.
 */
function applyDropAll(db: Database): void {
  db.run("BEGIN");
  try {
    for (const stmt of DROP_DDL) {
      db.run(stmt);
    }
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}

/**
 * Detect whether `projection_meta` exists and, if so, return the stored
 * schema_hash. Returns `null` on either:
 *   - The table doesn't exist (fresh file).
 *   - The table exists but has zero rows (extremely-rare edge case where a
 *     prior open created the schema but crashed before inserting the row).
 *
 * The query against `sqlite_master` avoids a noisy SQLITE_ERROR that would
 * occur from SELECTing on a missing table.
 */
function readStoredSchemaHash(db: Database): string | null {
  const tableExists = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='projection_meta'",
    )
    .all();
  if (tableExists.length === 0) return null;

  const rows = db
    .query<{ schema_hash: string }, []>(
      "SELECT schema_hash FROM projection_meta LIMIT 1",
    )
    .all();
  const first = rows[0];
  if (first === undefined) return null;
  return first.schema_hash;
}

/**
 * Row shape for `projection_meta`. SQLite returns NULL as `null` (not
 * `undefined`); the column types map directly to TS `string | null`.
 */
type MetaRow = {
  readonly schema_hash: string;
  readonly adopted_commit: string | null;
  readonly extension_set_hash: string | null;
  readonly processor_versions_hash: string | null;
  readonly capability_policy_hash: string | null;
  readonly built_at: string | null;
};

/**
 * Read the single `projection_meta` row. Returns `null` if the row is
 * missing (handled by the caller via re-insert).
 */
function readMetaRow(db: Database): ProjectionMeta | null {
  const rows = db
    .query<MetaRow, []>(
      "SELECT schema_hash, adopted_commit, extension_set_hash, "
        + "processor_versions_hash, capability_policy_hash, built_at "
        + "FROM projection_meta LIMIT 1",
    )
    .all();
  const r = rows[0];
  if (r === undefined) return null;
  return {
    schemaHash: r.schema_hash,
    // The `commitOid()` helper is the sqlite-read boundary equivalent of
    // a CommitOid construction. We don't validate 40-char-hex per
    // source-ref.ts §"v1 enforces only non-empty"; sqlite returning NULL
    // is the only failure case we guard.
    adoptedCommit:
      r.adopted_commit === null ? null : commitOid(r.adopted_commit),
    extensionSetHash: r.extension_set_hash,
    processorVersionsHash: r.processor_versions_hash,
    capabilityPolicyHash: r.capability_policy_hash,
    builtAt: r.built_at,
  };
}

/**
 * Insert (or replace) the single `projection_meta` row with the given
 * schema_hash and NULL cache keys. `INSERT OR REPLACE` because the PRIMARY
 * KEY is `schema_hash` — if a row with this hash already exists (shouldn't,
 * since we only call this on fresh or post-wipe paths), we overwrite it
 * rather than fail.
 */
function insertFreshMetaRow(db: Database, schemaHash: string): void {
  db.run(
    "INSERT OR REPLACE INTO projection_meta "
      + "(schema_hash, adopted_commit, extension_set_hash, "
      + "processor_versions_hash, capability_policy_hash, built_at) "
      + "VALUES (?, NULL, NULL, NULL, NULL, NULL)",
    [schemaHash],
  );
}
