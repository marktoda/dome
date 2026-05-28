// projection-diagnostics: per-table accessor for DiagnosticEffect rows.
// Owns the DiagnosticEffect → `diagnostics` row serialization and the row →
// DiagnosticEffect deserialization used by the Query API's `diagnostics`
// surface.
//
// Normative references:
//   - docs/wiki/specs/projection-store.md §"Tables — diagnostics"
//     (column shape + UNIQUE (processor_id, code, proposal_id,
//     source_refs_hash))
//   - docs/wiki/specs/projection-store.md §"Query API" (read surface)
//
// House-style notes (matches src/projections/db.ts, src/projections/facts.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - JSON column `source_refs` serialized via `JSON.stringify`; symmetric
//     `JSON.parse` on read.
//   - `source_refs_hash` is sha256-hex of the canonical JSON-stringified
//     sourceRefs array. Two diagnostics with identical sourceRefs hash to
//     the same value — that's the dedup discriminator. Two diagnostics
//     with distinct sourceRefs hash to different values and both insert.
//   - Row → DiagnosticEffect deserialization goes through `diagnosticEffect`.
//   - Returned arrays are `Object.freeze`'d.
//   - INSERT uses `INSERT OR IGNORE` to honor the UNIQUE constraint: a
//     re-emission of the same (processor_id, code, proposal_id,
//     source_refs_hash) quadruple is a no-op.

import { createHash } from "node:crypto";

import type { DiagnosticEffect } from "../core/effect";
import { diagnosticEffect } from "../core/effect";
import type { CommitOid, SourceRef } from "../core/source-ref";
import type { ProjectionDb } from "./db";

// ----- Public types ---------------------------------------------------------

export type DiagnosticInsertOpts = {
  readonly effect: DiagnosticEffect;
  readonly processorId: string;
  readonly proposalId: string | null;
  readonly adoptedCommit: CommitOid;
};

export type DiagnosticsFilter = {
  readonly severity?: "info" | "warning" | "error" | "block";
  readonly processorId?: string;
};

export type ResolveDiagnosticOpts = {
  readonly processorId: string;
  readonly code: string;
  readonly proposalId: string | null;
};

// ----- SQL ------------------------------------------------------------------

const INSERT_DIAGNOSTIC_SQL = `
INSERT OR IGNORE INTO diagnostics (
  severity, code, message, source_refs, source_refs_hash, processor_id,
  proposal_id, adopted_commit, written_at, resolved_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
`.trim();

const QUERY_ALL_SQL = `
SELECT severity, code, message, source_refs
FROM diagnostics
WHERE resolved_at IS NULL
ORDER BY id DESC
`.trim();

const QUERY_BY_SEVERITY_SQL = `
SELECT severity, code, message, source_refs
FROM diagnostics
WHERE resolved_at IS NULL AND severity = ?
ORDER BY id DESC
`.trim();

const QUERY_BY_PROCESSOR_SQL = `
SELECT severity, code, message, source_refs
FROM diagnostics
WHERE resolved_at IS NULL AND processor_id = ?
ORDER BY id DESC
`.trim();

const QUERY_BY_SEVERITY_AND_PROCESSOR_SQL = `
SELECT severity, code, message, source_refs
FROM diagnostics
WHERE resolved_at IS NULL AND severity = ? AND processor_id = ?
ORDER BY id DESC
`.trim();

const RESOLVE_SQL = `
UPDATE diagnostics
SET resolved_at = ?
WHERE processor_id = ? AND code = ? AND proposal_id IS ? AND resolved_at IS NULL
`.trim();

// ----- Row shape ------------------------------------------------------------

type DiagnosticRow = {
  readonly severity: string;
  readonly code: string;
  readonly message: string;
  readonly source_refs: string;
};

// ----- Public functions -----------------------------------------------------

/**
 * Insert a DiagnosticEffect row. The table's `UNIQUE (processor_id, code,
 * proposal_id, source_refs_hash)` constraint means re-emission of the
 * same diagnostic at the same source location is silently deduped via
 * `INSERT OR IGNORE` — but a single processor invocation that surfaces
 * many distinct diagnostics (e.g., validate-wikilinks finding N broken
 * links across N files) inserts all N rows.
 *
 * Throws on SQLite-level failure (disk full).
 */
export function insertDiagnostic(
  db: ProjectionDb,
  opts: DiagnosticInsertOpts,
): void {
  const { effect, processorId, proposalId, adoptedCommit } = opts;
  const sourceRefsJson = JSON.stringify(effect.sourceRefs);
  const sourceRefsHash = createHash("sha256").update(sourceRefsJson).digest("hex");
  db.raw.query(INSERT_DIAGNOSTIC_SQL).run(
    effect.severity,
    effect.code,
    effect.message,
    sourceRefsJson,
    sourceRefsHash,
    processorId,
    proposalId,
    adoptedCommit,
    new Date().toISOString(),
  );
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

  return Object.freeze(rows.map(rowToDiagnostic));
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

// ----- internals ------------------------------------------------------------

function rowToDiagnostic(row: DiagnosticRow): DiagnosticEffect {
  const sourceRefs = JSON.parse(row.source_refs) as ReadonlyArray<SourceRef>;
  return diagnosticEffect({
    severity: row.severity as DiagnosticEffect["severity"],
    code: row.code,
    message: row.message,
    sourceRefs,
  });
}
