// projection-query-view: builds the read-only `ProjectionQueryView` surface
// view-phase processors consume via `ctx.projection`.
//
// Per docs/wiki/matrices/projection-table-x-owner.md §"Read access via the
// query API", processors do NOT touch the SQLite handle directly — they
// consume this typed surface. View-phase processors that need to read
// facts (e.g., `dome.markdown.orphan-pages` reading every `links_to` row to
// compute incoming-link counts) call `ctx.projection.facts({ predicate })`
// rather than the raw `factsByPredicate` accessor.
//
// Composition layer only — no I/O, no validation. Delegates to the per-
// table accessor files (`./facts`, `./diagnostics`, `./questions`) and
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
  NodeRef,
  QuestionEffect,
} from "../core/effect";
import { nodeRef } from "../core/effect";
import type { ProjectionQueryView } from "../core/processor";

import type { ProjectionDb } from "./db";
import { queryDiagnostics } from "./diagnostics";
import { factsBySubject, factsByPredicate } from "./facts";
import { queryQuestions } from "./questions";

// ----- buildProjectionQueryView ---------------------------------------------

/**
 * Build a frozen `ProjectionQueryView` over an open `ProjectionDb`. The
 * returned handle exposes three accessors — facts, diagnostics, questions
 * — each delegating to the matching per-table accessor.
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
 *   - `questions`: delegates directly.
 */
export function buildProjectionQueryView(
  db: ProjectionDb,
): ProjectionQueryView {
  return Object.freeze({
    facts: (filter) => readFacts(db, filter ?? {}),
    diagnostics: (filter) => queryDiagnostics(db, filter ?? {}),
    questions: (filter) => queryQuestions(db, filter ?? {}),
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
 *   - predicate only          → factsByPredicate(namespace, predicate)
 *   - no filter               → all facts via a direct query
 *
 * The "no filter" path uses an inline SQL query rather than threading a
 * fourth accessor into `./facts` — view-phase processors that need every
 * fact are uncommon, and inlining keeps the per-table accessor file
 * focused on the two common shapes.
 */
function readFacts(
  db: ProjectionDb,
  filter: FactsFilter,
): ReadonlyArray<FactEffect> {
  const hasSubject =
    filter.subjectKind !== undefined && filter.subjectId !== undefined;
  const hasPredicate =
    filter.predicate !== undefined && filter.predicate.length > 0;

  if (hasSubject) {
    // subjectKind + subjectId both narrowed by the `hasSubject` check.
    const subject = buildSubject(
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

  // No filter — return every fact. Defensive bound is the caller's
  // responsibility; v1 has no LIMIT clause here.
  return readAllFacts(db);
}

/**
 * Construct a NodeRef from a generic `(kind, id)` pair. Each NodeRef
 * variant carries the id under a different field name (`page.path`,
 * `task.stableId`, `entity.name`).
 */
function buildSubject(
  kind: "page" | "task" | "entity",
  id: string,
): NodeRef {
  switch (kind) {
    case "page":
      return nodeRef({ kind: "page", path: id });
    case "task":
      return { kind: "task", stableId: id };
    case "entity":
      return { kind: "entity", name: id };
  }
}

/**
 * Compute the namespace prefix from a predicate string. Mirrors the
 * `predicateNamespace` helper in `./facts` — the namespace is everything
 * before the last dot; a predicate with no dot is its own namespace.
 */
function predicateNamespace(predicate: string): string {
  const idx = predicate.lastIndexOf(".");
  return idx === -1 ? predicate : predicate.slice(0, idx);
}

/**
 * Read every fact row from the projection. Used only by the "no filter"
 * branch of `readFacts`; otherwise the per-table accessors are preferred
 * (they push the predicate filter down to SQL).
 *
 * The query is intentionally minimal — same column selection as the
 * existing accessors so the row → FactEffect path is consistent.
 */
function readAllFacts(db: ProjectionDb): ReadonlyArray<FactEffect> {
  // Delegate to factsByPredicate with no predicate filter would require
  // a new SQL variant. The simplest implementation: list distinct
  // (namespace, predicate) pairs and union their results. The fact set
  // is small in practice (v1 processors that need "every fact" are rare).
  type Pair = { readonly namespace: string; readonly predicate: string };
  const pairs = db.raw
    .query<Pair, []>(
      "SELECT DISTINCT namespace, predicate FROM facts ORDER BY namespace, predicate",
    )
    .all();
  const out: FactEffect[] = [];
  for (const { namespace, predicate } of pairs) {
    for (const f of factsByPredicate(db, namespace, predicate)) {
      out.push(f);
    }
  }
  return Object.freeze(out);
}

// ----- Re-exports for the runtime --------------------------------------------
//
// Re-export the effect types so consumers that build a query view can type
// against this module rather than reaching into `../core/effect`.
export type { DiagnosticEffect, FactEffect, QuestionEffect };
