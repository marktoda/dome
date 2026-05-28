// scenarios/basic-adoption/idempotent-resync.scenario.test.ts
//
// Two ticks back-to-back with no intervening work: the second tick must be
// an in-sync no-op. Locks in idempotency of the drift detector after
// adoption completes.

import { expect } from "bun:test";

import { scenario } from "../../index";
import type { Harness } from "../../types";

scenario(
  {
    name: "basic-adoption: second tick after empty-diff init is in-sync no-op",
    tags: [
      { kind: "group", group: "basic-adoption" },
      { kind: "phase", phase: "adoption" },
    ],
  },
  async (h) => {
    // Step 1: first tick initializes adopted ref.
    const first = await h.tick();
    expect(first.adopted).toBe(true);

    // Capture state after the first tick.
    const refsAfterFirst = await h.refs.current();

    // Count ledger rows after the first tick (should be zero with no
    // bundles installed, but checked dynamically so the assertion is
    // about delta, not absolute count).
    const ledgerRowsBefore = await getLedgerRowCount(h);

    // Step 2: second tick is a no-op.
    const second = await h.tick();
    expect(second.hadDrift).toBe(false);

    // Step 3: refs are unchanged from the post-first-tick snapshot.
    const refsAfterSecond = await h.refs.current();
    expect(refsAfterSecond.head).toBe(refsAfterFirst.head);
    expect(refsAfterSecond.adopted).toBe(refsAfterFirst.adopted);

    // And the matcher snapshot (captured at the start of the second tick)
    // confirms neither ref moved during the second tick.
    await h.expectRef("refs/heads/main").toBeUnchanged();
    await h.expectRef("refs/dome/adopted/main").toBeUnchanged();

    // Step 4: ledger row count is unchanged.
    const ledgerRowsAfter = await getLedgerRowCount(h);
    expect(ledgerRowsAfter).toBe(ledgerRowsBefore);
  },
);

async function getLedgerRowCount(h: Harness): Promise<number> {
  const rows = h.ledger.raw
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs")
    .all();
  return rows[0]?.n ?? 0;
}
