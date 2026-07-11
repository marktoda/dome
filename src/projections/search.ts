// projections/search: FTS5 projection writes and reads.
//
// Search rows are produced only by SearchDocumentEffect and applied through
// the engine's `applyEffect` route after `search.write` capability
// enforcement. Processors never receive the SQLite handle.

import type { SearchDocumentEffect } from "../core/effect";
import { type CommitOid } from "../core/source-ref";
import type { SearchDocumentResult } from "../core/processor";
import { analyzeRecallQuery } from "../recall/query-analysis";
import { parseSourceRefsColumn } from "../sqlite/row-json";
import type { ProjectionDb } from "./db";

// ----- Writes ---------------------------------------------------------------

export function applySearchDocumentEffect(
  db: ProjectionDb,
  opts: {
    readonly effect: SearchDocumentEffect;
    readonly adoptedCommit: CommitOid;
  },
): void {
  // Row identity (per [[wiki/specs/projection-store]] §"fts_documents"):
  //   - delete operation          → clear every row for `path`.
  //   - page-level upsert         → clear every row for `path`, insert one.
  //   - sectioned upsert          → clear the (path, section_id) row plus
  //     any stale page-level row, insert the section row. The indexer emits
  //     a page delete ahead of its section upserts so removed sections do
  //     not linger; this branch only maintains per-section identity.
  if (opts.effect.operation === "delete" || opts.effect.sectionId === undefined) {
    db.raw
      .query<void, [string]>("DELETE FROM fts_documents WHERE path = ?")
      .run(opts.effect.path);
  } else {
    db.raw
      .query<void, [string, string]>(
        "DELETE FROM fts_documents WHERE path = ? "
          + "AND (section_id = ? OR section_id IS NULL)",
      )
      .run(opts.effect.path, opts.effect.sectionId);
  }

  if (opts.effect.operation === "delete") return;

  db.raw
    .query<
      void,
      [
        string,
        string | null,
        string | null,
        string,
        string | null,
        string,
        string,
        string,
        string,
      ]
    >(
      "INSERT INTO fts_documents "
        + "(path, section_id, breadcrumb, category, type, title, body, "
        + "source_refs, adopted_commit) "
        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      opts.effect.path,
      opts.effect.sectionId ?? null,
      opts.effect.breadcrumb ?? null,
      opts.effect.category,
      opts.effect.type ?? null,
      opts.effect.title,
      opts.effect.body,
      JSON.stringify(opts.effect.sourceRefs),
      opts.adoptedCommit,
    );
}

// ----- Reads ----------------------------------------------------------------

export function searchDocuments(
  db: ProjectionDb,
  filter: {
    readonly query: string;
    readonly category?: string;
    readonly type?: string;
    readonly limit?: number;
  },
): ReadonlyArray<SearchDocumentResult> {
  const query = analyzeRecallQuery(filter.query).fts;
  if (query === null) return Object.freeze([]);

  const clauses = ["fts_documents MATCH ?"];
  const params: Array<string | number> = [query];
  if (filter.category !== undefined) {
    clauses.push("category = ?");
    params.push(filter.category);
  }
  if (filter.type !== undefined) {
    clauses.push("type = ?");
    params.push(filter.type);
  }
  params.push(clampLimit(filter.limit));

  const rows = db.raw
    .query<SearchRow, Array<string | number>>(
      "SELECT "
        + "path, section_id, breadcrumb, category, type, title, "
        // No match-highlight markers: snippets are rendered verbatim into
        // query/export-context output, and bracket markers were
        // indistinguishable from real markdown ([[wikilinks]], [ ] tasks) —
        // the old downstream "strip the markers" pass deleted every [ and ]
        // from the snippet, destroying that syntax.
        + "snippet(fts_documents, -1, '', '', '...', 18) AS snippet, "
        + "bm25(fts_documents) AS rank, "
        + "source_refs "
        + "FROM fts_documents "
        + `WHERE ${clauses.join(" AND ")} `
        + "ORDER BY rank "
        + "LIMIT ?",
    )
    .all(...params);

  return Object.freeze(
    rows.map((row) => ({
      path: row.path,
      sectionId: row.section_id,
      breadcrumb: row.breadcrumb,
      category: row.category,
      type: row.type,
      title: row.title,
      snippet: row.snippet,
      rank: row.rank,
      sourceRefs: parseSourceRefs(row.source_refs),
    })),
  );
}

export function documentsByPath(
  db: ProjectionDb,
  paths: ReadonlyArray<string>,
): ReadonlyArray<SearchDocumentResult> {
  const uniquePaths = [...new Set(paths.filter((path) => path.length > 0))];
  if (uniquePaths.length === 0) return Object.freeze([]);

  const placeholders = uniquePaths.map(() => "?").join(", ");
  // Section rows are inserted in document order, so `ORDER BY rowid` makes
  // the first row per path the page's intro section — the most page-
  // representative row for exact-path recall.
  const rows = db.raw
    .query<PathSearchRow, string[]>(
      "SELECT "
        + "path, section_id, breadcrumb, category, type, title, body, source_refs "
        + "FROM fts_documents "
        + `WHERE path IN (${placeholders}) `
        + "ORDER BY rowid",
    )
    .all(...uniquePaths);
  const byPath = new Map<string, PathSearchRow>();
  for (const row of rows) {
    if (!byPath.has(row.path)) byPath.set(row.path, row);
  }

  return Object.freeze(
    uniquePaths.flatMap((path) => {
      const row = byPath.get(path);
      if (row === undefined) return [];
      return [{
        path: row.path,
        sectionId: row.section_id,
        breadcrumb: row.breadcrumb,
        category: row.category,
        type: row.type,
        title: row.title,
        snippet: snippetFromBody(stripBreadcrumbPrefix(row.body, row.breadcrumb)),
        rank: 1_000_000_000,
        sourceRefs: parseSourceRefs(row.source_refs),
      }];
    }),
  );
}

type SearchRow = {
  readonly path: string;
  readonly section_id: string | null;
  readonly breadcrumb: string | null;
  readonly category: string;
  readonly type: string | null;
  readonly title: string;
  readonly snippet: string;
  readonly rank: number;
  readonly source_refs: string;
};

type PathSearchRow = {
  readonly path: string;
  readonly section_id: string | null;
  readonly breadcrumb: string | null;
  readonly category: string;
  readonly type: string | null;
  readonly title: string;
  readonly body: string;
  readonly source_refs: string;
};

/**
 * Indexed section bodies carry the display breadcrumb as their first line so
 * heading terms match in FTS; strip it again when deriving a display snippet
 * from the raw body.
 */
function stripBreadcrumbPrefix(body: string, breadcrumb: string | null): string {
  if (breadcrumb === null) return body;
  if (!body.startsWith(breadcrumb)) return body;
  return body.slice(breadcrumb.length).replace(/^\s+/, "");
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return 10;
  return Math.max(1, Math.min(50, Math.trunc(raw)));
}

function snippetFromBody(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177).trimEnd()}...`;
}

function parseSourceRefs(raw: string) {
  return parseSourceRefsColumn(raw, "fts_documents.source_refs");
}
