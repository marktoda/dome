// scenarios/lifecycle/crash-and-restart-mid-stream.scenario.test.ts
//
// State persists across a daemon restart: refs, ledger, and projection rows
// survive `crashAndRestart()`. After the restart, the drift detector sees
// no work (everything's already adopted) and the tick is an in-sync no-op.

import { expect } from "bun:test";

import { scenario } from "../../index";
import type { Harness } from "../../types";

scenario(
  {
    name: "lifecycle: crashAndRestart preserves refs + ledger + projection; next tick is in-sync",
    tags: [
      { kind: "group", group: "lifecycle" },
      { kind: "lifecycle", event: "crash" },
      { kind: "lifecycle", event: "restart" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    // Step 0: init.
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }

    // Step 1: commit a markdown file with a broken wikilink (cheap effect:
    // one ledger row + one projection row, no closure commit).
    await h.userCommit({
      files: { "wiki/page.md": "[[missing]]\n" },
      message: "broken link",
    });
    const tick = await h.tick();
    expect(tick.adopted).toBe(true);

    // Snapshot pre-crash state.
    const refsBefore = await h.refs.current();
    const ledgerBefore = countLedger(h);
    const diagBefore = countDiagnostics(h);
    expect(ledgerBefore).toBeGreaterThan(0);
    expect(diagBefore).toBeGreaterThan(0);

    // Step 2: crash + restart.
    await h.crashAndRestart();

    // Step 3: refs survived.
    const refsAfter = await h.refs.current();
    expect(refsAfter.head).toBe(refsBefore.head);
    expect(refsAfter.adopted).toBe(refsBefore.adopted);

    // Ledger + projection rows survived.
    expect(countLedger(h)).toBe(ledgerBefore);
    expect(countDiagnostics(h)).toBe(diagBefore);

    // Step 4: post-restart tick is in-sync — nothing to do.
    const postTick = await h.tick();
    expect(postTick.hadDrift).toBe(false);
  },
);

function countLedger(h: Harness): number {
  return (
    h.ledger.raw
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs")
      .all()[0]?.n ?? 0
  );
}

function countDiagnostics(h: Harness): number {
  return (
    h.projection.raw
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM diagnostics")
      .all()[0]?.n ?? 0
  );
}
