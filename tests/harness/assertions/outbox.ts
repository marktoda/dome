// tests/harness/assertions/outbox.ts — OutboxMatcher implementation.
//
// Two checks for v1.0:
//   - `toHaveCount({ status })` returns a `.matching(n)` thenable that
//     verifies row count. Surface mirrors the matcher interface in
//     `../types`.
//   - `toHaveNoStaleRows(maxAgeMs)` ensures no `pending` row is older
//     than `maxAgeMs` relative to the harness clock — the lightweight
//     "outbox is making progress" check.

import { expect } from "bun:test";

import type { Harness, OutboxMatcher } from "../types";

type OutboxStatus = "pending" | "sent" | "failed";

export class OutboxMatcherImpl implements OutboxMatcher {
  constructor(private readonly h: Harness) {}

  toHaveCount(filter?: { status?: OutboxStatus }): {
    matching(n: number): Promise<void>;
  } {
    const h = this.h;
    const f = filter ?? {};
    return {
      async matching(n: number): Promise<void> {
        const rows = queryOutbox(h, f);
        expect(
          rows.length,
          `expected ${n} outbox row(s)${f.status === undefined ? "" : ` with status='${f.status}'`}; ` +
            `got ${rows.length}`,
        ).toBe(n);
      },
    };
  }

  async toHaveNoStaleRows(maxAgeMs: number): Promise<void> {
    const cutoff = new Date(this.h.clock.nowMs() - maxAgeMs).toISOString();
    const stale = this.h.outbox.raw
      .query<{ id: number; idempotency_key: string; enqueued_at: string }, [string]>(
        `SELECT id, idempotency_key, enqueued_at FROM outbox ` +
          `WHERE status = 'pending' AND enqueued_at < ?`,
      )
      .all(cutoff);
    expect(
      stale.length,
      `expected zero outbox rows older than ${maxAgeMs}ms in 'pending'; got ${stale.length}: ` +
        stale.map((r) => `${r.id}/${r.idempotency_key}`).join(", "),
    ).toBe(0);
  }
}

type OutboxRow = { id: number; status: string };

function queryOutbox(
  h: Harness,
  f: { status?: OutboxStatus },
): ReadonlyArray<OutboxRow> {
  if (f.status === undefined) {
    return h.outbox.raw
      .query<OutboxRow, []>("SELECT id, status FROM outbox")
      .all();
  }
  return h.outbox.raw
    .query<OutboxRow, [string]>("SELECT id, status FROM outbox WHERE status = ?")
    .all(f.status);
}
