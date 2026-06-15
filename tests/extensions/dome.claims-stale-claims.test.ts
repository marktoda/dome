// dome.claims.stale-claims — unit tests for the view-phase staleness processor.
//
// Staleness is a view-phase computation: a claim is stale when its durable
// `asOf` date (carried clock-free on every dome.claims.claim fact) is older
// than a configurable horizon, measured against the INJECTED clock ctx.now().
// Never a persisted fact — that would break PROJECTIONS_ARE_REBUILDABLE. These
// tests pin determinism: a fixed injected `now` makes the ViewEffect data a
// pure function of (facts, config, now).
//
// Pattern: fake ProjectionQueryView with seeded claim FactEffects, run the
// processor, inspect the structured ViewEffect's data. Mirrors
// tests/extensions/daily-today-view.test.ts (makeProjection / makeSnapshot /
// makeProcessorContext) and the orphan-pages view-effect shape.

import { describe, expect, test } from "bun:test";

import staleClaims from "../../assets/extensions/dome.claims/processors/stale-claims";
import type { FactEffect, ViewEffect } from "../../src/core/effect";
import {
  treeOid,
  type ExtensionConfig,
  type ProjectionQueryView,
  type Snapshot,
} from "../../src/core/processor";
import { makeManualProposal } from "../../src/core/proposal";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HEAD_COMMIT = commitOid("abcdef1234567890abcdef1234567890abcdef12");
// Fixed injected clock — every staleness computation is measured against this.
const NOW = new Date("2026-06-14T00:00:00Z");

const CLAIM_PREDICATE = "dome.claims.claim";

type StaleClaim = {
  readonly path: string;
  readonly key: string;
  readonly value: string;
  readonly asOf: string;
  readonly daysStale: number;
};

function makeClaimFact(opts: {
  path: string;
  key: string;
  value: string;
  asOf: string | null;
}): FactEffect {
  return {
    kind: "fact",
    subject: { kind: "page", path: opts.path as never },
    predicate: CLAIM_PREDICATE,
    object: {
      kind: "string",
      value: JSON.stringify({
        key: opts.key,
        value: opts.value,
        asOf: opts.asOf,
      }),
    },
    assertion: "extracted",
    sourceRefs: [{ commit: HEAD_COMMIT, path: opts.path as never }],
  };
}

function makeProjection(facts: ReadonlyArray<FactEffect>): ProjectionQueryView {
  return {
    facts: (filter?: { readonly predicate?: string }) =>
      facts.filter(
        (f) =>
          filter?.predicate === undefined || f.predicate === filter.predicate,
      ),
    diagnostics: () => [],
    questions: () => [],
    searchDocuments: () => [],
    documentsByPath: () => [],
  } as unknown as ProjectionQueryView;
}

function makeSnapshot(): Snapshot {
  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: treeOid("1111111111111111111111111111111111111111"),
    readFile: async () => null,
    listMarkdownFiles: async () => Object.freeze([]),
    getFileInfo: async () => null,
  });
}

async function runStaleClaims(opts: {
  facts: ReadonlyArray<FactEffect>;
  config?: ExtensionConfig;
}): Promise<{
  readonly view: ViewEffect;
  readonly data: {
    readonly schema: string;
    readonly asOfCommit: string;
    readonly horizonDays: number;
    readonly staleClaims: ReadonlyArray<StaleClaim>;
  };
}> {
  const ctx = makeProcessorContext({
    snapshot: makeSnapshot(),
    changedPaths: Object.freeze([]),
    proposal: makeManualProposal({
      base: HEAD_COMMIT,
      head: HEAD_COMMIT,
      branch: "main",
    }),
    runId: "run-stale-claims-test",
    now: NOW,
    signal: new AbortController().signal,
    input: { kind: "command", commandArgs: {} },
    projection: makeProjection(opts.facts),
    ...(opts.config !== undefined ? { extensionConfig: opts.config } : {}),
  });
  const effects = await staleClaims.run(ctx as never);
  const view = effects.find((e): e is ViewEffect => e.kind === "view");
  if (view === undefined) throw new Error("no view effect emitted");
  if (view.content.kind !== "structured") {
    throw new Error("not a structured view");
  }
  return {
    view,
    data: view.content.data as never,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dome.claims.stale-claims — staleness filtering over asOf", () => {
  test("lists only claims older than the horizon, most-stale-first", async () => {
    const { data } = await runStaleClaims({
      // horizon 120 days, now 2026-06-14.
      // "2026-01-01" → 164 days stale → STALE.
      // "2026-06-10" → 4 days → fresh.
      facts: [
        makeClaimFact({
          path: "wiki/a.md",
          key: "Status",
          value: "Shipped",
          asOf: "2026-06-10",
        }),
        makeClaimFact({
          path: "wiki/b.md",
          key: "Owner",
          value: "Danny",
          asOf: "2026-01-01",
        }),
      ],
      config: { stale_claims_horizon_days: 120 },
    });

    expect(data.horizonDays).toBe(120);
    expect(data.staleClaims).toHaveLength(1);
    const stale = data.staleClaims[0];
    expect(stale?.path).toBe("wiki/b.md");
    expect(stale?.key).toBe("Owner");
    expect(stale?.value).toBe("Danny");
    expect(stale?.asOf).toBe("2026-01-01");
    expect(stale?.daysStale).toBe(164);
  });

  test("sorts multiple stale claims most-stale-first", async () => {
    const { data } = await runStaleClaims({
      facts: [
        makeClaimFact({
          path: "wiki/a.md",
          key: "K1",
          value: "v1",
          asOf: "2025-06-14", // ~365 days
        }),
        makeClaimFact({
          path: "wiki/b.md",
          key: "K2",
          value: "v2",
          asOf: "2026-01-01", // 164 days
        }),
      ],
      config: { stale_claims_horizon_days: 120 },
    });

    expect(data.staleClaims).toHaveLength(2);
    expect(data.staleClaims[0]?.path).toBe("wiki/a.md");
    expect(data.staleClaims[1]?.path).toBe("wiki/b.md");
    expect(data.staleClaims[0]?.daysStale).toBeGreaterThan(
      data.staleClaims[1]?.daysStale ?? 0,
    );
  });

  test("claims with asOf: null are excluded (no staleness without a date)", async () => {
    const { data } = await runStaleClaims({
      facts: [
        makeClaimFact({
          path: "wiki/a.md",
          key: "Status",
          value: "Unknown date",
          asOf: null,
        }),
        makeClaimFact({
          path: "wiki/b.md",
          key: "Owner",
          value: "Danny",
          asOf: "2026-01-01",
        }),
      ],
      config: { stale_claims_horizon_days: 120 },
    });

    expect(data.staleClaims).toHaveLength(1);
    expect(data.staleClaims[0]?.path).toBe("wiki/b.md");
  });

  test("custom horizon of 30 days makes a 60-day-old claim stale", async () => {
    const { data } = await runStaleClaims({
      facts: [
        makeClaimFact({
          path: "wiki/a.md",
          key: "Status",
          value: "Active",
          asOf: "2026-04-15", // 60 days before 2026-06-14
        }),
      ],
      config: { stale_claims_horizon_days: 30 },
    });

    expect(data.horizonDays).toBe(30);
    expect(data.staleClaims).toHaveLength(1);
    expect(data.staleClaims[0]?.daysStale).toBe(60);
  });

  test("strips the inline *(as of …)* marker from value, keeping asOf structured", async () => {
    // The indexer stores `value` WITH the inline marker and extracts `asOf`
    // separately; the decoder must strip the marker so `value` is clean and not
    // doubled. Without the strip this row's value would be the verbatim
    // "Shipped *(as of 2026-01-01)*".
    const { data } = await runStaleClaims({
      facts: [
        makeClaimFact({
          path: "wiki/a.md",
          key: "Status",
          value: "Shipped *(as of 2026-01-01)*",
          asOf: "2026-01-01", // 164 days → stale under horizon 120
        }),
      ],
      config: { stale_claims_horizon_days: 120 },
    });

    expect(data.staleClaims).toHaveLength(1);
    expect(data.staleClaims[0]?.value).toBe("Shipped");
    expect(data.staleClaims[0]?.asOf).toBe("2026-01-01");
  });

  test("exact horizon boundary: daysStale === horizon is EXCLUDED, +1 is INCLUDED", async () => {
    // now = 2026-06-14, horizon H = 120.
    // "2026-02-14" is exactly 120 days before now → daysStale === 120 → EXCLUDED
    //   (strict `> horizon`).
    // "2026-02-13" is exactly 121 days before now → daysStale === 121 → INCLUDED.
    const { data } = await runStaleClaims({
      facts: [
        makeClaimFact({
          path: "wiki/at-horizon.md",
          key: "Status",
          value: "At horizon",
          asOf: "2026-02-14",
        }),
        makeClaimFact({
          path: "wiki/over-horizon.md",
          key: "Status",
          value: "Over horizon",
          asOf: "2026-02-13",
        }),
      ],
      config: { stale_claims_horizon_days: 120 },
    });

    expect(data.staleClaims).toHaveLength(1);
    expect(data.staleClaims[0]?.path).toBe("wiki/over-horizon.md");
    expect(data.staleClaims[0]?.daysStale).toBe(121);
  });

  test("no stale claims yields an empty staleClaims array, not an error", async () => {
    const { view, data } = await runStaleClaims({
      facts: [
        makeClaimFact({
          path: "wiki/a.md",
          key: "Status",
          value: "Fresh",
          asOf: "2026-06-10", // 4 days
        }),
      ],
      config: { stale_claims_horizon_days: 120 },
    });

    expect(view.kind).toBe("view");
    expect(data.staleClaims).toEqual([]);
  });
});

describe("dome.claims.stale-claims — determinism", () => {
  test("same facts + same injected now → identical ViewEffect data", async () => {
    const facts = [
      makeClaimFact({
        path: "wiki/b.md",
        key: "Owner",
        value: "Danny",
        asOf: "2026-01-01",
      }),
      makeClaimFact({
        path: "wiki/a.md",
        key: "Status",
        value: "Shipped",
        asOf: "2026-06-10",
      }),
      makeClaimFact({
        path: "wiki/c.md",
        key: "Era",
        value: "Old",
        asOf: "2025-06-14",
      }),
    ];

    const first = await runStaleClaims({
      facts,
      config: { stale_claims_horizon_days: 90 },
    });
    const second = await runStaleClaims({
      facts,
      config: { stale_claims_horizon_days: 90 },
    });

    expect(second.data).toEqual(first.data);
  });
});
