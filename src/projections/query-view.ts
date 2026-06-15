// projection-query-view: builds the read-only `ProjectionQueryView` surface
// view-phase processors consume via `ctx.projection`.
//
// Per docs/wiki/matrices/projection-table-x-owner.md §"Read access via the
// query API", processors do NOT touch the SQLite handle directly — they
// consume this typed surface. View-phase processors that need to read
// facts (e.g., `dome.markdown.orphan-pages` reading every `links_to` row to
// compute incoming-link counts) or search documents call the typed query API
// rather than the raw `factsByPredicate` accessor.
//
// Composition layer only — no I/O, no validation. Delegates to the per-
// table accessor files (`./facts`, `./diagnostics`, `./questions`, `./search`) and
// wraps them in a frozen handle. The accessor files own the SQL + the
// row → effect deserialization; this file just narrows the read surface
// to the four shapes view-phase processors need.
//
// House-style notes (matches src/projections/sinks.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - `Object.freeze` on the returned handle so misbehaving callers cannot
//     swap a function out post-construction.
//   - No imports from `src/engine/`; the only constructor helper used here is
//     `nodeRef(...)` to preserve the canonical VaultPath boundary.
//   - Pure: same `(db, filter)` → same array (the underlying SQL is
//     read-only).

import type {
  DiagnosticEffect,
  FactEffect,
} from "../core/effect";
import type {
  ProjectionQueryView,
  ProjectionQuestion,
} from "../core/processor";

import type { ProjectionDb } from "./db";
import { queryDiagnostics } from "./diagnostics";
import {
  allFacts,
  factsBySubject,
  factsByPredicate,
  predicateNamespace,
  rebuildSubject,
} from "./facts";
import {
  queryQuestionRecords,
  type QuestionRecord,
} from "./questions";
import { documentsByPath, searchDocuments } from "./search";

// ----- buildProjectionQueryView ---------------------------------------------

/**
 * Build a frozen `ProjectionQueryView` over an open `ProjectionDb`. The
 * returned handle exposes table-shaped accessors — facts, diagnostics,
 * questions, searchDocuments — each delegating to the matching per-table
 * accessor.
 *
 * Filter handling:
 *   - `facts({ predicate, subjectKind?, subjectId? })`:
 *       - both `subjectKind` and `subjectId` set → uses `factsBySubject`
 *         and post-filters by predicate (if set).
 *       - `predicate` set, subject not → uses `factsByPredicate` with the
 *         predicate's namespace derived as everything before the last
 *         dot (mirroring `predicateNamespace` in `./facts`).
 *       - no filter → returns every fact (caller bounds the result).
 *   - `diagnostics`: delegates directly.
 *   - `questions`: delegates to durable question records and exposes the row
 *      id alongside the effect fields for resolve-ready views.
 */
export function buildProjectionQueryView(
  db: ProjectionDb,
): ProjectionQueryView {
  return Object.freeze({
    facts: (filter) => readFacts(db, filter ?? {}),
    diagnostics: (filter) => queryDiagnostics(db, filter ?? {}),
    questions: (filter) =>
      Object.freeze(
        queryQuestionRecords(db, filter ?? {}).map(questionProjectionResult),
      ),
    searchDocuments: (filter) => searchDocuments(db, filter),
    documentsByPath: (paths) => documentsByPath(db, paths),
  });
}

// ----- internals ------------------------------------------------------------

type FactsFilter = {
  readonly predicate?: string;
  readonly subjectKind?: "page" | "task" | "entity";
  readonly subjectId?: string;
};

/**
 * Read facts under the v1 filter surface. The per-table accessors expose
 * subject and (namespace, predicate) lookups; this function dispatches on
 * the filter shape and post-filters in JS when the accessors can't push
 * the constraint down to SQL.
 *
 * Filter dispatch:
 *   - subject + predicate     → factsBySubject(...), filter by predicate
 *   - subject only            → factsBySubject(...)
 *   - partial subject         → empty (fail closed; never broaden)
 *   - predicate only          → factsByPredicate(namespace, predicate)
 *   - no filter               → all facts
 */
function readFacts(
  db: ProjectionDb,
  filter: FactsFilter,
): ReadonlyArray<FactEffect> {
  const hasSubject =
    filter.subjectKind !== undefined && filter.subjectId !== undefined;
  const hasPartialSubject =
    (filter.subjectKind === undefined) !== (filter.subjectId === undefined);
  const hasPredicate =
    filter.predicate !== undefined && filter.predicate.length > 0;

  if (hasPartialSubject) return Object.freeze([]);

  if (hasSubject) {
    // subjectKind + subjectId both narrowed by the `hasSubject` check.
    const subject = rebuildSubject(
      filter.subjectKind as "page" | "task" | "entity",
      filter.subjectId as string,
    );
    const rows = factsBySubject(db, subject);
    if (!hasPredicate) return rows;
    return Object.freeze(rows.filter((r) => r.predicate === filter.predicate));
  }

  if (hasPredicate) {
    const predicate = filter.predicate as string;
    const namespace = predicateNamespace(predicate);
    return factsByPredicate(db, namespace, predicate);
  }

  return allFacts(db);
}

function questionProjectionResult(
  record: QuestionRecord,
): ProjectionQuestion {
  return Object.freeze({
    ...record.effect,
    id: record.id,
    processorId: record.processorId,
    adoptedCommit: record.adoptedCommit,
    askedAt: record.askedAt,
    answeredAt: record.answeredAt,
    answer: record.answer,
  });
}

// ----- Re-exports for the runtime --------------------------------------------
//
// Re-export the effect types so consumers that build a query view can type
// against this module rather than reaching into `../core/effect`.
export type { DiagnosticEffect, FactEffect, ProjectionQuestion };
