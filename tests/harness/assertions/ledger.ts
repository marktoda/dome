// tests/harness/assertions/ledger.ts — LedgerMatcher implementation.
//
// Filters the runs table by an optional `LedgerFilter` (processorId,
// status, and/or `withOutputCommit` for NULL vs NOT NULL on
// `output_commit`) and exposes the shape `LedgerMatcher` declares. Run
// rows are projected to the `LedgerRunRowProjection` shape declared in
// `../types` so the matcher stays decoupled from `RunRow` internals.
//
// `processorId` + `status` are forwarded to `queryRuns`; the
// `withOutputCommit` predicate is applied in-process because `queryRuns`
// does not expose an output-commit filter (the column is engine-write-
// time metadata, not a query axis the ledger surface owns).

import { expect } from "bun:test";

import { orphanRuns, queryRuns, type RunRow } from "../../../src/ledger/runs";
import type {
  Harness,
  LedgerFilter,
  LedgerMatcher,
  LedgerRunRowProjection,
} from "../types";

const ORPHAN_THRESHOLD_MS = 60_000;

export class LedgerMatcherImpl implements LedgerMatcher {
  constructor(
    private readonly h: Harness,
    private readonly filter: LedgerFilter,
  ) {}

  async toHaveCount(n: number): Promise<void> {
    const rows = this.queryMatching();
    expect(
      rows.length,
      `expected ${n} ledger row(s) matching ${this.describeFilter()}; got ${rows.length}` +
        this.dump(rows),
    ).toBe(n);
  }

  async toHaveAtLeastOne(): Promise<LedgerRunRowProjection> {
    const rows = this.queryMatching();
    expect(
      rows.length > 0,
      `expected at least one ledger row matching ${this.describeFilter()}; got 0`,
    ).toBe(true);
    // queryRuns orders by started_at DESC — first row is the most recent.
    const first = rows[0];
    if (first === undefined) {
      throw new Error("ledger: invariant — rows.length > 0 but rows[0] undefined");
    }
    return projectRow(first);
  }

  async toHaveExactlyOne(): Promise<LedgerRunRowProjection> {
    const rows = this.queryMatching();
    expect(
      rows.length,
      `expected exactly one ledger row matching ${this.describeFilter()}; got ${rows.length}` +
        this.dump(rows),
    ).toBe(1);
    const only = rows[0];
    if (only === undefined) {
      throw new Error("ledger: invariant — rows.length == 1 but rows[0] undefined");
    }
    return projectRow(only);
  }

  async toAllHaveStatus(
    status: "succeeded" | "failed" | "skipped",
  ): Promise<void> {
    const rows = this.queryMatching();
    expect(
      rows.length > 0,
      `toAllHaveStatus: no ledger rows matched ${this.describeFilter()}`,
    ).toBe(true);
    for (const r of rows) {
      expect(
        r.status,
        `ledger row ${r.id} (processor=${r.processorId}) has status='${r.status}'; expected '${status}'`,
      ).toBe(status);
    }
  }

  async toHaveNoOrphans(): Promise<void> {
    const orphans = orphanRuns(
      this.h.ledger,
      ORPHAN_THRESHOLD_MS,
      this.h.clock.now(),
    );
    expect(
      orphans.length,
      `expected zero orphan ledger rows; got ${orphans.length}: ` +
        orphans.map((r) => r.id).join(", "),
    ).toBe(0);
  }

  // ----- internals --------------------------------------------------------

  private queryMatching(): ReadonlyArray<RunRow> {
    // Build the queryRuns filter from the subset of fields it understands.
    // `withOutputCommit` is a post-filter (queryRuns doesn't expose it).
    const baseFilter: { processorId?: string; status?: RunRow["status"] } = {};
    if (this.filter.processorId !== undefined) {
      baseFilter.processorId = this.filter.processorId;
    }
    if (this.filter.status !== undefined) {
      baseFilter.status = this.filter.status;
    }
    const rows =
      Object.keys(baseFilter).length === 0
        ? queryRuns(this.h.ledger)
        : queryRuns(this.h.ledger, baseFilter);

    if (this.filter.withOutputCommit === undefined) return rows;
    const want = this.filter.withOutputCommit;
    return rows.filter((r) =>
      want ? r.outputCommit !== null : r.outputCommit === null,
    );
  }

  private describeFilter(): string {
    const parts: string[] = [];
    if (this.filter.processorId !== undefined) {
      parts.push(`processorId: ${JSON.stringify(this.filter.processorId)}`);
    }
    if (this.filter.status !== undefined) {
      parts.push(`status: ${JSON.stringify(this.filter.status)}`);
    }
    if (this.filter.withOutputCommit !== undefined) {
      parts.push(`withOutputCommit: ${this.filter.withOutputCommit}`);
    }
    if (parts.length === 0) return "(no filter)";
    return `{ ${parts.join(", ")} }`;
  }

  private dump(rows: ReadonlyArray<RunRow>): string {
    if (rows.length === 0) return "";
    const lines = rows
      .slice(0, 5)
      .map(
        (r) =>
          `  - ${r.id} processor=${r.processorId} status=${r.status} phase=${r.phase}`,
      );
    return `\nfirst ${Math.min(5, rows.length)} row(s):\n${lines.join("\n")}`;
  }
}

function projectRow(r: RunRow): LedgerRunRowProjection {
  return {
    id: r.id,
    processorId: r.processorId,
    phase: r.phase,
    status: r.status,
    inputCommit: r.inputCommit,
    outputCommit: r.outputCommit,
    error: r.error,
  };
}

