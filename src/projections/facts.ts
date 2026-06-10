// projection-facts: per-table accessor for FactEffect rows. Owns the
// FactEffect → `facts` row serialization and the row → FactEffect
// deserialization used by the Query API's `factsBySubject` and
// `factsByPredicate` surfaces.
//
// Normative references:
//   - docs/wiki/specs/projection-store.md §"Tables — facts" (column shape)
//   - docs/wiki/specs/projection-store.md §"Query API" (read surface)
//   - docs/wiki/specs/effects.md §"FactEffect" (namespace = predicate prefix
//     before the last dot — the spec's worked example `dome.tasks.dueDate`
//     → namespace `dome.tasks` resolves the ambiguity in the wording)
//
// House-style notes (matches src/projections/db.ts, src/engine/core/closure-commit.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - JSON columns (`object_json`, `source_refs`) serialized via
//     `JSON.stringify`; symmetric `JSON.parse` on read.
//   - Row → FactEffect deserialization goes through `factEffect(...)` so the
//     same Zod-refinement guarantees hold for reads as for writes.
//   - Returned arrays are `Object.freeze`'d.
//   - `noUncheckedIndexedAccess` discipline: SQLite `.all()` returns arrays
//     of typed row shapes; mapping is functional (no index access).

import { z } from "zod";

import type { FactEffect, NodeRef, NodeRefInput, Literal } from "../core/effect";
import {
  factEffect,
  FactEffectSchema,
  LiteralSchema,
  nodeRef,
  NodeRefSchema,
} from "../core/effect";
import type { CommitOid } from "../core/source-ref";
import { parseJsonColumn, parseSourceRefsColumn } from "../sqlite/row-json";
import type { ProjectionDb } from "./db";

// ----- Public types ---------------------------------------------------------

export type FactInsertOpts = {
  readonly effect: FactEffect;
  readonly processorId: string;
  readonly runId: string;
  readonly adoptedCommit: CommitOid;
};

export type ResolveStalePageFactsOpts = {
  readonly processorId: string;
  readonly inspectedPaths: ReadonlyArray<string>;
};

export type FactRecordFilter = {
  readonly predicate?: string;
  readonly subjectKind?: "page" | "task" | "entity";
  readonly subjectId?: string;
};

export type FactRecord = {
  readonly id: number;
  readonly effect: FactEffect;
  readonly namespace: string;
  readonly processorId: string;
  readonly runId: string;
  readonly adoptedCommit: CommitOid;
  readonly writtenAt: string;
};

// ----- SQL ------------------------------------------------------------------

const INSERT_FACT_SQL = `
INSERT INTO facts (
  namespace, subject_kind, subject_id, predicate, object_json,
  assertion, confidence, source_refs, processor_id, run_id, adopted_commit,
  written_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`.trim();

const FACTS_BY_SUBJECT_SQL = `
SELECT namespace, subject_kind, subject_id, predicate, object_json,
       assertion, confidence, source_refs
FROM facts
WHERE subject_kind = ? AND subject_id = ?
ORDER BY id
`.trim();

const FACTS_BY_PREDICATE_SQL = `
SELECT namespace, subject_kind, subject_id, predicate, object_json,
       assertion, confidence, source_refs
FROM facts
WHERE namespace = ? AND predicate = ?
ORDER BY id
`.trim();

const ALL_FACTS_SQL = `
SELECT namespace, subject_kind, subject_id, predicate, object_json,
       assertion, confidence, source_refs
FROM facts
ORDER BY id
`.trim();

const ALL_FACT_RECORDS_SQL = `
SELECT id, namespace, subject_kind, subject_id, predicate, object_json,
       assertion, confidence, source_refs, processor_id, run_id, adopted_commit,
       written_at
FROM facts
ORDER BY id
`.trim();

const DELETE_PAGE_FACTS_BY_PROCESSOR_AND_SUBJECT_SQL = `
DELETE FROM facts
WHERE processor_id = ? AND subject_kind = 'page' AND subject_id = ?
`.trim();

// ----- Row shape ------------------------------------------------------------

type FactRow = {
  readonly namespace: string;
  readonly subject_kind: string;
  readonly subject_id: string;
  readonly predicate: string;
  readonly object_json: string;
  readonly assertion: string;
  readonly confidence: number | null;
  readonly source_refs: string;
};

type FactRecordRow = FactRow & {
  readonly id: number;
  readonly processor_id: string;
  readonly run_id: string;
  readonly adopted_commit: CommitOid;
  readonly written_at: string;
};

const FactObjectSchema = z.union([NodeRefSchema, LiteralSchema]);
const FactAssertionSchema = z.enum([
  "explicit",
  "extracted",
  "inferred",
  "generated",
]);

// ----- Public functions -----------------------------------------------------

/**
 * Insert a FactEffect row. Throws on SQLite-level failure (disk full,
 * constraint violation). Programmer errors at the type boundary (e.g., a
 * FactEffect missing `sourceRefs`) are caught at construction time by the
 * `factEffect()` Zod refinement; this function trusts the typed input.
 */
export function insertFact(db: ProjectionDb, opts: FactInsertOpts): void {
  const { effect, processorId, runId, adoptedCommit } = opts;
  const namespace = predicateNamespace(effect.predicate);
  db.raw.query(INSERT_FACT_SQL).run(
    namespace,
    effect.subject.kind,
    subjectId(effect.subject),
    effect.predicate,
    JSON.stringify(effect.object),
    effect.assertion,
    effect.confidence ?? null,
    JSON.stringify(effect.sourceRefs),
    processorId,
    runId,
    adoptedCommit,
    new Date().toISOString(),
  );
}

/**
 * Read every fact about a subject (page / task / entity). Returns a frozen
 * array; ordering is insertion order (`ORDER BY id`).
 */
export function factsBySubject(
  db: ProjectionDb,
  subject: NodeRefInput,
): ReadonlyArray<FactEffect> {
  const normalized = nodeRef(subject);
  const rows = db.raw
    .query<FactRow, [string, string]>(FACTS_BY_SUBJECT_SQL)
    .all(normalized.kind, subjectId(normalized));
  return Object.freeze(rows.map(rowToFact));
}

/**
 * Read every fact with a given (namespace, predicate). Returns a frozen
 * array; ordering is insertion order (`ORDER BY id`).
 */
export function factsByPredicate(
  db: ProjectionDb,
  namespace: string,
  predicate: string,
): ReadonlyArray<FactEffect> {
  const rows = db.raw
    .query<FactRow, [string, string]>(FACTS_BY_PREDICATE_SQL)
    .all(namespace, predicate);
  return Object.freeze(rows.map(rowToFact));
}

/**
 * Read every fact row in insertion order. This is intentionally a projection
 * accessor rather than query-view inline SQL, so all facts deserialization
 * stays in one module.
 */
export function allFacts(db: ProjectionDb): ReadonlyArray<FactEffect> {
  const rows = db.raw.query<FactRow, []>(ALL_FACTS_SQL).all();
  return Object.freeze(rows.map(rowToFact));
}

/**
 * Read fact rows with inspection metadata. This accessor is for debugging /
 * provenance surfaces; processors should continue to consume `FactEffect`
 * values through `ProjectionQueryView.facts`.
 */
export function queryFactRecords(
  db: ProjectionDb,
  filter: FactRecordFilter = {},
): ReadonlyArray<FactRecord> {
  const rows = db.raw.query<FactRecordRow, []>(ALL_FACT_RECORDS_SQL).all();
  return Object.freeze(
    rows
      .map(rowToFactRecord)
      .filter((record) => factRecordMatches(record, filter)),
  );
}

/**
 * Clear page-subject facts for paths a processor just re-inspected. The
 * engine calls this before routing the processor's newly emitted FactEffects,
 * so each successful run replaces that processor's extracted facts for the
 * inspected page set instead of appending stale rows forever.
 *
 * Scope is intentionally narrow: page-subject facts are the v1 extraction
 * shape used by graph/link/tag processors. Task/entity fact lifecycles need
 * their own stable identity policy before automatic invalidation is safe.
 */
export function resolveStalePageFacts(
  db: ProjectionDb,
  opts: ResolveStalePageFactsOpts,
): number {
  if (opts.inspectedPaths.length === 0) return 0;
  const stmt = db.raw.query(DELETE_PAGE_FACTS_BY_PROCESSOR_AND_SUBJECT_SQL);
  let deleted = 0;
  for (const path of new Set(opts.inspectedPaths)) {
    const result = stmt.run(opts.processorId, path);
    deleted += result.changes;
  }
  return deleted;
}

// ----- internals ------------------------------------------------------------

/**
 * Project the NodeRef discriminator to the `subject_id` column value. The
 * three NodeRef kinds carry different id-bearing fields; this function
 * normalizes to the single TEXT column.
 */
function subjectId(s: NodeRef): string {
  switch (s.kind) {
    case "page":
      return s.path;
    case "task":
      return s.stableId;
    case "entity":
      return s.name;
  }
}

/**
 * Compute the `namespace` column value from a `FactEffect.predicate`. Per
 * spec the namespace is the dotted prefix before the predicate's terminal
 * segment (e.g., `dome.tasks.dueDate` → `dome.tasks`). A predicate with no
 * dot is its own namespace.
 */
function predicateNamespace(predicate: string): string {
  const idx = predicate.lastIndexOf(".");
  return idx === -1 ? predicate : predicate.slice(0, idx);
}

/**
 * Rebuild a NodeRef from `(subject_kind, subject_id)`. Throws on unknown
 * kind (a row corrupted at the SQL boundary — programmer error or external
 * tampering with the db file).
 */
function rebuildSubject(kind: string, id: string): NodeRef {
  switch (kind) {
    case "page":
      return nodeRef({ kind: "page", path: id });
    case "task":
      return { kind: "task", stableId: id };
    case "entity":
      return { kind: "entity", name: id };
    default:
      throw new Error(`projection.facts: unknown subject_kind '${kind}'`);
  }
}

/**
 * Row → FactEffect. Goes through `factEffect()` so the same Zod-refinement
 * guarantees (non-empty sourceRefs; confidence required for inferred /
 * generated) that protect writes also protect reads — a malformed row
 * throws via the constructor's downstream callers.
 */
function rowToFact(row: FactRow): FactEffect {
  const subject = rebuildSubject(row.subject_kind, row.subject_id);
  const object = parseJsonColumn<NodeRef | Literal>(
    row.object_json,
    "facts.object_json",
    FactObjectSchema,
  );
  const sourceRefs = parseSourceRefsColumn(
    row.source_refs,
    "facts.source_refs",
  );
  const assertion = FactAssertionSchema.parse(row.assertion);
  const input: Omit<FactEffect, "kind"> =
    row.confidence === null
      ? { subject, predicate: row.predicate, object, assertion, sourceRefs }
      : {
          subject,
          predicate: row.predicate,
          object,
          assertion,
          sourceRefs,
          confidence: row.confidence,
        };
  const effect = factEffect(input);
  FactEffectSchema.parse(effect);
  return effect;
}

function rowToFactRecord(row: FactRecordRow): FactRecord {
  return Object.freeze({
    id: row.id,
    effect: rowToFact(row),
    namespace: row.namespace,
    processorId: row.processor_id,
    runId: row.run_id,
    adoptedCommit: row.adopted_commit,
    writtenAt: row.written_at,
  });
}

function factRecordMatches(
  record: FactRecord,
  filter: FactRecordFilter,
): boolean {
  if (
    filter.predicate !== undefined &&
    record.effect.predicate !== filter.predicate
  ) {
    return false;
  }
  if (filter.subjectKind === undefined && filter.subjectId === undefined) {
    return true;
  }
  return (
    record.effect.subject.kind === filter.subjectKind &&
    subjectId(record.effect.subject) === filter.subjectId
  );
}
