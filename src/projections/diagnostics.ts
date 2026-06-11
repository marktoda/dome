// projection-diagnostics: per-table accessor for DiagnosticEffect rows.
// Owns the DiagnosticEffect → `diagnostics` row serialization and the row →
// DiagnosticEffect deserialization used by the Query API's `diagnostics`
// surface.
//
// Normative references:
//   - docs/wiki/specs/projection-store.md §"Tables — diagnostics"
//     (column shape + UNIQUE (processor_id, code, proposal_id,
//     subject_hash))
//   - docs/wiki/specs/projection-store.md §"Query API" (read surface)
//
// House-style notes (matches src/projections/db.ts, src/projections/facts.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - JSON column `source_refs` serialized via `JSON.stringify`; symmetric
//     `JSON.parse` on read.
//   - `subject_hash` is sha256-hex of the CONTENT identity of the sourceRefs
//     array: `{ path, range, stableId }` per ref, with `commit` and `blob`
//     deliberately dropped. Two diagnostics anchored to the same vault span
//     hash to the same value regardless of which candidate commit they
//     were emitted against — that's the dedup discriminator.
//
//     Why content-based rather than provenance-based: the adoption loop
//     re-runs processors against successive candidate commits. A
//     `validate-wikilinks` diagnostic anchored at `wiki/foo.md` line 3
//     should land exactly once even when the broker fires twice — once on
//     the user's commit, again on the closure commit after a sibling
//     `normalize-frontmatter` patch advanced the candidate. Hashing the
//     full SourceRef (commit + blob included) over-distinguished those
//     two emissions and let duplicate rows accumulate; hashing only the
//     content shape collapses them.
//   - Row → DiagnosticEffect deserialization goes through `diagnosticEffect`.
//   - Returned arrays are `Object.freeze`'d.
//   - INSERT uses `INSERT OR IGNORE` to honor the UNIQUE constraint: a
//     re-emission of the same (processor_id, code, proposal_id,
//     subject_hash) quadruple is a no-op.

import { createHash } from "node:crypto";
import { z } from "zod";

import type { DiagnosticEffect } from "../core/effect";
import { diagnosticEffect, DiagnosticEffectSchema } from "../core/effect";
import { commitOid, type CommitOid, type SourceRef } from "../core/source-ref";
import { parseSourceRefsColumn } from "../sqlite/row-json";
import { mapRows } from "../sqlite/rows";
import type { ProjectionDb } from "./db";

// ----- Public types ---------------------------------------------------------

export type DiagnosticInsertOpts = {
  readonly effect: DiagnosticEffect;
  readonly processorId: string;
  readonly runId?: string;
  readonly proposalId: string | null;
  readonly adoptedCommit: CommitOid;
};

export type DiagnosticsFilter = {
  readonly severity?: "info" | "warning" | "error" | "block";
  readonly processorId?: string;
};

export type DiagnosticRecord = {
  readonly id: number;
  readonly effect: DiagnosticEffect;
  readonly processorId: string;
  readonly runId: string | null;
  readonly proposalId: string | null;
  readonly adoptedCommit: CommitOid;
  readonly writtenAt: string;
  readonly resolvedAt: string | null;
};

export type ResolveDiagnosticOpts = {
  readonly processorId: string;
  readonly code: string;
  readonly proposalId: string | null;
};

export type ResolveStaleDiagnosticsOpts = {
  readonly processorId: string;
  readonly inspectedPaths: ReadonlyArray<string>;
  readonly emittedDiagnostics: ReadonlyArray<DiagnosticEffect>;
};

// ----- SQL ------------------------------------------------------------------

const INSERT_DIAGNOSTIC_SQL = `
INSERT OR IGNORE INTO diagnostics (
  severity, code, message, source_refs, subject_hash, processor_id,
  run_id, proposal_id, adopted_commit, written_at, resolved_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
`.trim();

const QUERY_ALL_SQL = `
SELECT d.id, d.severity, d.code, d.message, d.source_refs, d.processor_id,
       d.run_id, d.proposal_id, d.adopted_commit, d.written_at, d.resolved_at
FROM diagnostics d
WHERE d.resolved_at IS NULL AND NOT EXISTS (
  SELECT 1
  FROM diagnostics newer
  WHERE newer.resolved_at IS NULL
    AND newer.processor_id = d.processor_id
    AND newer.code = d.code
    AND newer.subject_hash = d.subject_hash
    AND newer.id > d.id
)
ORDER BY d.id DESC
`.trim();

const QUERY_BY_SEVERITY_SQL = `
SELECT d.id, d.severity, d.code, d.message, d.source_refs, d.processor_id,
       d.run_id, d.proposal_id, d.adopted_commit, d.written_at, d.resolved_at
FROM diagnostics d
WHERE d.resolved_at IS NULL AND d.severity = ? AND NOT EXISTS (
  SELECT 1
  FROM diagnostics newer
  WHERE newer.resolved_at IS NULL
    AND newer.processor_id = d.processor_id
    AND newer.code = d.code
    AND newer.subject_hash = d.subject_hash
    AND newer.id > d.id
)
ORDER BY d.id DESC
`.trim();

const QUERY_BY_PROCESSOR_SQL = `
SELECT d.id, d.severity, d.code, d.message, d.source_refs, d.processor_id,
       d.run_id, d.proposal_id, d.adopted_commit, d.written_at, d.resolved_at
FROM diagnostics d
WHERE d.resolved_at IS NULL AND d.processor_id = ? AND NOT EXISTS (
  SELECT 1
  FROM diagnostics newer
  WHERE newer.resolved_at IS NULL
    AND newer.processor_id = d.processor_id
    AND newer.code = d.code
    AND newer.subject_hash = d.subject_hash
    AND newer.id > d.id
)
ORDER BY d.id DESC
`.trim();

const QUERY_BY_SEVERITY_AND_PROCESSOR_SQL = `
SELECT d.id, d.severity, d.code, d.message, d.source_refs, d.processor_id,
       d.run_id, d.proposal_id, d.adopted_commit, d.written_at, d.resolved_at
FROM diagnostics d
WHERE d.resolved_at IS NULL AND d.severity = ? AND d.processor_id = ?
  AND NOT EXISTS (
    SELECT 1
    FROM diagnostics newer
    WHERE newer.resolved_at IS NULL
      AND newer.processor_id = d.processor_id
      AND newer.code = d.code
      AND newer.subject_hash = d.subject_hash
      AND newer.id > d.id
  )
ORDER BY d.id DESC
`.trim();

const RESOLVE_SQL = `
UPDATE diagnostics
SET resolved_at = ?
WHERE processor_id = ? AND code = ? AND proposal_id IS ? AND resolved_at IS NULL
`.trim();

const QUERY_UNRESOLVED_BY_PROCESSOR_SQL = `
SELECT id, code, source_refs, subject_hash
FROM diagnostics
WHERE processor_id = ? AND resolved_at IS NULL
`.trim();

const RESOLVE_BY_ID_SQL = `
UPDATE diagnostics
SET resolved_at = ?
WHERE id = ? AND resolved_at IS NULL
`.trim();

// ----- Row shape ------------------------------------------------------------

type DiagnosticRow = {
  readonly id: number;
  readonly severity: string;
  readonly code: string;
  readonly message: string;
  readonly source_refs: string;
  readonly processor_id: string;
  readonly run_id: string | null;
  readonly proposal_id: string | null;
  readonly adopted_commit: string;
  readonly written_at: string;
  readonly resolved_at: string | null;
};

type UnresolvedDiagnosticRow = {
  readonly id: number;
  readonly code: string;
  readonly source_refs: string;
  readonly subject_hash: string;
};

const DiagnosticSeveritySchema = z.enum(["info", "warning", "error", "block"]);

// ----- Public functions -----------------------------------------------------

/**
 * Insert a DiagnosticEffect row. The table's `UNIQUE (processor_id, code,
 * proposal_id, subject_hash)` constraint means re-emission of the same
 * diagnostic at the same source location is silently deduped via
 * `INSERT OR IGNORE` — but a single processor invocation that surfaces
 * many distinct diagnostics (e.g., validate-wikilinks finding N broken
 * links across N files) inserts all N rows.
 *
 * `subject_hash` excludes `commit` and `blob` so a diagnostic re-emitted
 * against a successor candidate (the adoption loop's normal behavior when
 * a sibling patch advances the tree) dedupes against the prior emission.
 *
 * Throws on SQLite-level failure (disk full).
 */
export function insertDiagnostic(
  db: ProjectionDb,
  opts: DiagnosticInsertOpts,
): void {
  const { effect, processorId, runId, proposalId, adoptedCommit } = opts;
  const sourceRefsJson = JSON.stringify(effect.sourceRefs);
  const subjectHash = computeSubjectHash(effect.sourceRefs);
  db.raw.query(INSERT_DIAGNOSTIC_SQL).run(
    effect.severity,
    effect.code,
    effect.message,
    sourceRefsJson,
    subjectHash,
    processorId,
    runId ?? null,
    proposalId,
    adoptedCommit,
    new Date().toISOString(),
  );
}

/**
 * Compute the content-identity hash used as the dedup discriminator in
 * `UNIQUE (processor_id, code, proposal_id, subject_hash)`. Projects each
 * SourceRef to the content subset (`path`, `range`, `stableId`) and drops
 * `commit` + `blob`. Two SourceRefs that anchor to the same vault location
 * across different candidate commits hash to the same value.
 *
 * Range and stableId default to `null` (not `undefined`) so a ref with
 * `range: undefined` and a ref that explicitly omits `range` hash to the
 * same value — JSON.stringify drops `undefined` keys, but normalizing to
 * `null` makes the projection self-documenting at the call site.
 */
function computeSubjectHash(
  sourceRefs: ReadonlyArray<SourceRef>,
): string {
  const content = sourceRefs.map((r) => ({
    path: r.path,
    range: r.range ?? null,
    stableId: r.stableId ?? null,
  }));
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export function diagnosticSubjectHash(
  effect: DiagnosticEffect,
): string {
  return computeSubjectHash(effect.sourceRefs);
}

/**
 * Read every unresolved diagnostic, optionally filtered by severity and/or
 * processor. Returns a frozen array; ordering is insertion order
 * (`ORDER BY id DESC`).
 */
export function queryDiagnostics(
  db: ProjectionDb,
  filter?: DiagnosticsFilter,
): ReadonlyArray<DiagnosticEffect> {
  return Object.freeze(
    queryDiagnosticRecords(db, filter).map((record) => record.effect),
  );
}

/**
 * Read unresolved diagnostic rows with producer metadata. This is the
 * inspection/provenance surface; processor QueryViews should normally consume
 * `queryDiagnostics`, which exposes only the Effect-level contract.
 */
export function queryDiagnosticRecords(
  db: ProjectionDb,
  filter?: DiagnosticsFilter,
): ReadonlyArray<DiagnosticRecord> {
  const severity = filter?.severity;
  const processorId = filter?.processorId;

  let rows: ReadonlyArray<DiagnosticRow>;
  if (severity !== undefined && processorId !== undefined) {
    rows = db.raw
      .query<DiagnosticRow, [string, string]>(
        QUERY_BY_SEVERITY_AND_PROCESSOR_SQL,
      )
      .all(severity, processorId);
  } else if (severity !== undefined) {
    rows = db.raw
      .query<DiagnosticRow, [string]>(QUERY_BY_SEVERITY_SQL)
      .all(severity);
  } else if (processorId !== undefined) {
    rows = db.raw
      .query<DiagnosticRow, [string]>(QUERY_BY_PROCESSOR_SQL)
      .all(processorId);
  } else {
    rows = db.raw.query<DiagnosticRow, []>(QUERY_ALL_SQL).all();
  }

  return mapRows(rows, rowToDiagnosticRecord);
}

/**
 * Mark a diagnostic as resolved (the user fixed the issue, the next
 * adoption pass re-ran the processor, and the same `(processor_id, code,
 * proposal_id)` triple should no longer be visible to queries).
 *
 * No-op if no matching row exists or the matching row was already resolved.
 */
export function resolveDiagnostic(
  db: ProjectionDb,
  opts: ResolveDiagnosticOpts,
): void {
  db.raw.query(RESOLVE_SQL).run(
    new Date().toISOString(),
    opts.processorId,
    opts.code,
    opts.proposalId,
  );
}

/**
 * Resolve stale diagnostics for a processor after it re-checks a bounded set
 * of paths. Path-scoped diagnostics are considered only when their source refs
 * touch an inspected path. Source-less diagnostics are processor-run scoped
 * rather than path-scoped, so any later successful run of the same processor
 * may resolve them when it does not re-emit the same `(code, subject_hash)`.
 *
 * This is intentionally projection-owned. Processors remain pure effect
 * producers; they don't need to remember or mutate their prior rows.
 */
export function resolveStaleDiagnostics(
  db: ProjectionDb,
  opts: ResolveStaleDiagnosticsOpts,
): number {
  const inspected = new Set(opts.inspectedPaths);
  const keep = new Set(
    opts.emittedDiagnostics.map(
      (effect) => `${effect.code}\0${diagnosticSubjectHash(effect)}`,
    ),
  );
  const rows = db.raw
    .query<UnresolvedDiagnosticRow, [string]>(QUERY_UNRESOLVED_BY_PROCESSOR_SQL)
    .all(opts.processorId);
  const scopedRows = rows.filter((row) =>
    diagnosticIsInResolvedScope(row.source_refs, inspected)
  );
  const latestKeptIdByKey = new Map<string, number>();
  for (const row of scopedRows) {
    const key = diagnosticKey(row);
    if (!keep.has(key)) continue;
    const current = latestKeptIdByKey.get(key);
    if (current === undefined || row.id > current) {
      latestKeptIdByKey.set(key, row.id);
    }
  }

  let resolved = 0;
  const now = new Date().toISOString();
  const stmt = db.raw.query(RESOLVE_BY_ID_SQL);
  for (const row of scopedRows) {
    const key = diagnosticKey(row);
    if (keep.has(key) && latestKeptIdByKey.get(key) === row.id) continue;
    stmt.run(now, row.id);
    resolved += 1;
  }
  return resolved;
}

// ----- internals ------------------------------------------------------------

function rowToDiagnostic(row: DiagnosticRow): DiagnosticEffect {
  const sourceRefs = parseSourceRefsColumn(
    row.source_refs,
    "diagnostics.source_refs",
  );
  const effect = diagnosticEffect({
    severity: DiagnosticSeveritySchema.parse(row.severity),
    code: row.code,
    message: row.message,
    sourceRefs,
  });
  DiagnosticEffectSchema.parse(effect);
  return effect;
}

function rowToDiagnosticRecord(row: DiagnosticRow): DiagnosticRecord {
  return Object.freeze({
    id: row.id,
    effect: rowToDiagnostic(row),
    processorId: row.processor_id,
    runId: row.run_id,
    proposalId: row.proposal_id,
    adoptedCommit: commitOid(row.adopted_commit),
    writtenAt: row.written_at,
    resolvedAt: row.resolved_at,
  });
}

function diagnosticIsInResolvedScope(
  sourceRefsJson: string,
  paths: ReadonlySet<string>,
): boolean {
  let refs: ReadonlyArray<SourceRef>;
  try {
    refs = parseSourceRefsColumn(
      sourceRefsJson,
      "diagnostics.source_refs",
    );
  } catch {
    return false;
  }
  if (refs.length === 0) return true;
  return refs.some((ref) => paths.has(ref.path as string));
}

function diagnosticKey(row: UnresolvedDiagnosticRow): string {
  return `${row.code}\0${row.subject_hash}`;
}
