// tests/harness/assertions/projection.ts — ProjectionMatcher implementation.
//
// Queries the three projection tables (`facts`, `diagnostics`, `questions`)
// via the raw `Database` handle exposed by `ProjectionDb.raw`. Reads only —
// the matcher never mutates the database. H1 surfaces row-count and
// substring-match checks; richer filters land in later phases as
// scenarios demand them.

import { expect } from "bun:test";

import type { Harness, ProjectionMatcher } from "../types";

type DiagFilter = { severity?: string; code?: string };
type FactsFilter = { predicate?: string; subjectId?: string };

export class ProjectionMatcherImpl implements ProjectionMatcher {
  constructor(private readonly h: Harness) {}

  diagnostics(filter?: DiagFilter): {
    toHaveCount(n: number): Promise<void>;
    toContainMessage(substring: string): Promise<void>;
    toAllHaveAdoptedCommit(expected: string): Promise<void>;
  } {
    const h = this.h;
    const f = filter ?? {};
    return {
      async toHaveCount(n: number): Promise<void> {
        const rows = queryDiagnostics(h, f);
        expect(
          rows.length,
          `expected ${n} diagnostics row(s) matching ${describeDiagFilter(f)}; got ${rows.length}`,
        ).toBe(n);
      },
      async toContainMessage(substring: string): Promise<void> {
        const rows = queryDiagnostics(h, f);
        const found = rows.some((r) => r.message.includes(substring));
        expect(
          found,
          `expected a diagnostic message containing ${JSON.stringify(substring)}; ` +
            `searched ${rows.length} row(s) matching ${describeDiagFilter(f)}`,
        ).toBe(true);
      },
      /**
       * Assert every matching row's `adopted_commit` column equals
       * `expected`. Designed for the sub-Proposal frame-correctness
       * scenarios (Phase 4a' fix-up): diagnostics emitted during a
       * sub-adoption should be tagged with the sub-Proposal's head, not
       * the parent's. Catches the closure-reuse bug class.
       */
      async toAllHaveAdoptedCommit(expected: string): Promise<void> {
        const rows = queryDiagnostics(h, f);
        const mismatches = rows.filter((r) => r.adoptedCommit !== expected);
        expect(
          mismatches.length,
          `expected all ${rows.length} diagnostic row(s) to have ` +
            `adopted_commit=${expected.slice(0, 7)}; ` +
            `${mismatches.length} mismatched (first: ` +
            `code=${mismatches[0]?.code} adopted=${mismatches[0]?.adoptedCommit.slice(0, 7)})`,
        ).toBe(0);
      },
    };
  }

  facts(filter?: FactsFilter): { toHaveCount(n: number): Promise<void> } {
    const h = this.h;
    const f = filter ?? {};
    return {
      async toHaveCount(n: number): Promise<void> {
        const rows = queryFacts(h, f);
        expect(
          rows.length,
          `expected ${n} facts row(s) matching ${describeFactsFilter(f)}; got ${rows.length}`,
        ).toBe(n);
      },
    };
  }

  questions(): { toHaveCount(n: number): Promise<void> } {
    const h = this.h;
    return {
      async toHaveCount(n: number): Promise<void> {
        const rows = h.projection.raw
          .query<{ id: number }, []>("SELECT id FROM questions")
          .all();
        expect(
          rows.length,
          `expected ${n} questions row(s); got ${rows.length}`,
        ).toBe(n);
      },
    };
  }
}

// ----- queries --------------------------------------------------------------

type DiagRow = {
  id: number;
  severity: string;
  code: string;
  message: string;
  adoptedCommit: string;
};

type DiagRowSql = {
  id: number;
  severity: string;
  code: string;
  message: string;
  adopted_commit: string;
};

function queryDiagnostics(h: Harness, f: DiagFilter): ReadonlyArray<DiagRow> {
  const clauses: string[] = [];
  const params: string[] = [];
  if (f.severity !== undefined) {
    clauses.push("severity = ?");
    params.push(f.severity);
  }
  if (f.code !== undefined) {
    clauses.push("code = ?");
    params.push(f.code);
  }
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const rows = h.projection.raw
    .query<DiagRowSql, string[]>(
      `SELECT id, severity, code, message, adopted_commit FROM diagnostics${where}`,
    )
    .all(...params);
  return rows.map((r) => ({
    id: r.id,
    severity: r.severity,
    code: r.code,
    message: r.message,
    adoptedCommit: r.adopted_commit,
  }));
}

type FactRow = { id: number };

function queryFacts(h: Harness, f: FactsFilter): ReadonlyArray<FactRow> {
  const clauses: string[] = [];
  const params: string[] = [];
  if (f.predicate !== undefined) {
    clauses.push("predicate = ?");
    params.push(f.predicate);
  }
  if (f.subjectId !== undefined) {
    clauses.push("subject_id = ?");
    params.push(f.subjectId);
  }
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  return h.projection.raw
    .query<FactRow, string[]>(`SELECT id FROM facts${where}`)
    .all(...params);
}

function describeDiagFilter(f: DiagFilter): string {
  const parts: string[] = [];
  if (f.severity !== undefined) parts.push(`severity=${f.severity}`);
  if (f.code !== undefined) parts.push(`code=${f.code}`);
  return parts.length === 0 ? "(no filter)" : `{ ${parts.join(", ")} }`;
}

function describeFactsFilter(f: FactsFilter): string {
  const parts: string[] = [];
  if (f.predicate !== undefined) parts.push(`predicate=${f.predicate}`);
  if (f.subjectId !== undefined) parts.push(`subjectId=${f.subjectId}`);
  return parts.length === 0 ? "(no filter)" : `{ ${parts.join(", ")} }`;
}
