// projections/search: FTS5 projection writes and reads.
//
// Search rows are produced only by SearchDocumentEffect and applied through
// the engine's `applyEffect` route after `search.write` capability
// enforcement. Processors never receive the SQLite handle.

import type { SearchDocumentEffect } from "../core/effect";
import {
  blobOid,
  commitOid,
  sourceRef,
  SourceRefSchema,
  type CommitOid,
  type SourceRef,
  type TextRange,
} from "../core/source-ref";
import type { SearchDocumentResult } from "../core/processor";
import type { ProjectionDb } from "./db";

// ----- Writes ---------------------------------------------------------------

export function applySearchDocumentEffect(
  db: ProjectionDb,
  opts: {
    readonly effect: SearchDocumentEffect;
    readonly adoptedCommit: CommitOid;
  },
): void {
  db.raw
    .query<void, [string]>("DELETE FROM fts_documents WHERE path = ?")
    .run(opts.effect.path);

  if (opts.effect.operation === "delete") return;

  db.raw
    .query<
      void,
      [string, string, string | null, string, string, string, string]
    >(
      "INSERT INTO fts_documents "
        + "(path, category, type, title, body, source_refs, adopted_commit) "
        + "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      opts.effect.path,
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
  const query = toFtsQuery(filter.query);
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
        + "path, category, type, title, "
        + "snippet(fts_documents, -1, '[', ']', '...', 18) AS snippet, "
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
      category: row.category,
      type: row.type,
      title: row.title,
      snippet: row.snippet,
      rank: row.rank,
      sourceRefs: parseSourceRefs(row.source_refs),
    })),
  );
}

type SearchRow = {
  readonly path: string;
  readonly category: string;
  readonly type: string | null;
  readonly title: string;
  readonly snippet: string;
  readonly rank: number;
  readonly source_refs: string;
};

function toFtsQuery(raw: string): string | null {
  const terms = raw
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/"/g, '""'))
    .filter((term) => term.length > 0);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"`).join(" ");
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return 10;
  return Math.max(1, Math.min(50, Math.trunc(raw)));
}

function parseSourceRefs(raw: string): ReadonlyArray<SourceRef> {
  const parsed = JSON.parse(raw) as unknown;
  const refs = SourceRefSchema.array().parse(parsed);
  return Object.freeze(
    refs.map((ref) =>
      sourceRef({
        commit: commitOid(ref.commit),
        path: ref.path,
        ...(ref.blob !== undefined ? { blob: blobOid(ref.blob) } : {}),
        ...(ref.range !== undefined ? { range: textRange(ref.range) } : {}),
        ...(ref.stableId !== undefined ? { stableId: ref.stableId } : {}),
      }),
    ),
  );
}

function textRange(raw: {
  readonly startLine: number;
  readonly endLine: number;
  readonly startChar?: number | undefined;
  readonly endChar?: number | undefined;
}): TextRange {
  const range: { -readonly [K in keyof TextRange]: TextRange[K] } = {
    startLine: raw.startLine,
    endLine: raw.endLine,
  };
  if (raw.startChar !== undefined) range.startChar = raw.startChar;
  if (raw.endChar !== undefined) range.endChar = raw.endChar;
  return Object.freeze(range);
}
