import { describe, expect, test } from "bun:test";

import type { FactEffect } from "../../src/core/effect";
import type {
  SearchDocumentResult,
  SnapshotFileInfo,
} from "../../src/core/processor";
import { commitOid, type CommitOid } from "../../src/core/source-ref";
import { requireVaultPath } from "../../src/core/vault-path";
import {
  applyRecencyDecay,
  compareRankedSearchEntries,
  dedupeBestSectionPerPage,
  expandedSearchLimit,
  fuseSearchChannelsRrf,
  linkExpansionChannel,
  rankSearchCandidate,
} from "../../assets/extensions/dome.search/processors/ranking";

describe("dome.search ranking", () => {
  test("expands the FTS candidate set before result slicing", () => {
    expect(expandedSearchLimit(1)).toBe(12);
    expect(expandedSearchLimit(8)).toBe(32);
    expect(expandedSearchLimit(50)).toBe(51);
  });

  test("scores source-backed signals and explains them", () => {
    const ranking = rankSearchCandidate({
      match: match({ path: "wiki/project-alpha.md", rank: 4, type: "project" }),
      facts: [
        fact("dome.daily.open_task"),
        fact("dome.daily.decision"),
        fact("dome.graph.tagged"),
        fact("dome.graph.links_to"),
      ],
      diagnostics: [{ severity: "warning" }],
      questions: [{ id: 42 }],
    });

    expect(ranking.score).toBe(19);
    expect(ranking.ftsRank).toBe(4);
    expect(ranking.reasons).toEqual([
      "project page",
      "open loop",
      "decision",
      "unresolved question",
      "active diagnostic",
      "2 graph signals",
    ]);
    expect(ranking.signals.map((signal) => signal.kind)).toEqual([
      "page-type",
      "open-loop",
      "decision",
      "question",
      "diagnostic",
      "graph",
    ]);
  });

  test("summarizes high-cardinality graph signals without noisy counts", () => {
    const ranking = rankSearchCandidate({
      match: match({ path: "wiki/log.md", rank: 4, type: null }),
      facts: Array.from({ length: 20 }, () => fact("dome.graph.links_to")),
      diagnostics: [],
      questions: [],
    });

    expect(ranking.score).toBe(3);
    expect(ranking.reasons).toEqual(["many graph signals"]);
    expect(ranking.signals).toContainEqual(
      expect.objectContaining({
        kind: "graph",
        count: 20,
      }),
    );
  });

  test("scores projection recall signals ahead of weak FTS-only matches", () => {
    const ranking = rankSearchCandidate({
      match: match({ path: "wiki/signal-only.md", rank: 1_000_000_000, type: "concept" }),
      facts: [],
      diagnostics: [],
      questions: [],
      recallSignals: [
        {
          label: "open-loop topic match",
          weight: 8,
        },
      ],
    });

    expect(ranking.score).toBe(9);
    expect(ranking.reasons).toEqual([
      "open-loop topic match",
      "concept page",
    ]);
    expect(ranking.signals.map((signal) => signal.kind)).toEqual([
      "recall",
      "page-type",
    ]);
  });

  test("claim-bearing pages get a modest additive nudge over claim-less ones", () => {
    const baseInput = {
      match: match({ path: "wiki/projects/platform.md", rank: 2, type: "project" }),
      diagnostics: [] as const,
      questions: [] as const,
    };
    const withClaims = rankSearchCandidate({
      ...baseInput,
      facts: [
        claimFact({ key: "Status", value: "shipping" }),
        claimFact({ key: "Owner", value: "danny" }),
      ],
    });
    const withoutClaims = rankSearchCandidate({
      ...baseInput,
      facts: [],
    });

    expect(withClaims.score).toBeGreaterThan(withoutClaims.score);
    expect(withClaims.signals.some((s) => s.kind === "claim")).toBe(true);
  });

  test("the claim signal is capped at weight 3 (4 claims do not exceed it)", () => {
    const ranking = rankSearchCandidate({
      match: match({ path: "wiki/projects/platform.md", rank: 2, type: null }),
      facts: [
        claimFact({ key: "Status", value: "shipping" }),
        claimFact({ key: "Owner", value: "danny" }),
        claimFact({ key: "Stage", value: "ga" }),
        claimFact({ key: "Risk", value: "low" }),
      ],
      diagnostics: [],
      questions: [],
    });
    const signal = ranking.signals.find((s) => s.kind === "claim");
    expect(signal?.count).toBe(4);
    expect(signal?.weight).toBe(3); // cap = 3
  });

  test("the claim signal contributes weight-per-item below the cap (2 claims → 2)", () => {
    const ranking = rankSearchCandidate({
      match: match({ path: "wiki/projects/platform.md", rank: 2, type: null }),
      facts: [
        claimFact({ key: "Status", value: "shipping" }),
        claimFact({ key: "Owner", value: "danny" }),
      ],
      diagnostics: [],
      questions: [],
    });
    const signal = ranking.signals.find((s) => s.kind === "claim");
    expect(signal?.weight).toBe(2);
  });

  test("sorts boosted matches ahead of weaker FTS-only matches", () => {
    const ftsOnly = {
      path: "wiki/fts-only.md",
      rank: 1,
      ranking: rankSearchCandidate({
        match: match({ path: "wiki/fts-only.md", rank: 1, type: null }),
        facts: [],
        diagnostics: [],
        questions: [],
      }),
    };
    const openLoop = {
      path: "wiki/open-loop.md",
      rank: 8,
      ranking: rankSearchCandidate({
        match: match({ path: "wiki/open-loop.md", rank: 8, type: "project" }),
        facts: [fact("dome.daily.open_task")],
        diagnostics: [],
        questions: [],
      }),
    };

    expect([ftsOnly, openLoop].sort(compareRankedSearchEntries)).toEqual([
      openLoop,
      ftsOnly,
    ]);
  });
});

describe("dome.search section dedup", () => {
  test("keeps the best-ranked section per page, preserving order", () => {
    const sections = [
      sectionMatch("wiki/a.md", "intro", 1),
      sectionMatch("wiki/b.md", "plan", 2),
      sectionMatch("wiki/a.md", "plan", 3),
      sectionMatch("wiki/b.md", "intro", 4),
    ];
    const deduped = dedupeBestSectionPerPage(sections);
    expect(deduped.map((m) => `${m.path}#${m.sectionId}`)).toEqual([
      "wiki/a.md#intro",
      "wiki/b.md#plan",
    ]);
  });
});

describe("dome.search link expansion + RRF fusion", () => {
  const allPaths = [
    "wiki/entities/danny-rosen.md",
    "wiki/projects/platform.md",
    "wiki/projects/rollout.md",
    "wiki/other.md",
  ];

  test("expands one hop over links_to in both directions, ranked by linking hit", () => {
    const expansion = linkExpansionChannel({
      ftsPaths: ["wiki/entities/danny-rosen.md", "wiki/other.md"],
      linksToFacts: [
        // Outgoing: the #1 hit links to platform (basename target).
        linksTo("wiki/entities/danny-rosen.md", "platform"),
        // Incoming: rollout links to the #2 hit (path-without-extension).
        linksTo("wiki/projects/rollout.md", "wiki/other"),
        // Unrelated link between non-seeds is ignored.
        linksTo("wiki/projects/rollout.md", "platform"),
      ],
      allMarkdownPaths: allPaths,
    });
    expect(expansion.map((e) => e.path)).toEqual([
      "wiki/projects/platform.md",
      "wiki/projects/rollout.md",
    ]);
    expect(expansion[0]?.bestSeedRank).toBe(1);
    expect(expansion[1]?.bestSeedRank).toBe(2);
  });

  test("seed pages are never expansion entries", () => {
    const expansion = linkExpansionChannel({
      ftsPaths: ["wiki/entities/danny-rosen.md", "wiki/projects/platform.md"],
      linksToFacts: [
        linksTo("wiki/entities/danny-rosen.md", "platform"),
      ],
      allMarkdownPaths: allPaths,
    });
    expect(expansion).toEqual([]);
  });

  test("RRF weights: direct FTS hits dominate link-only entries (k=60, half-weight link channel)", () => {
    const fusion = fuseSearchChannelsRrf({
      ftsPaths: ["wiki/entities/danny-rosen.md", "wiki/other.md"],
      expansion: [
        { path: "wiki/projects/platform.md", bestSeedRank: 1, viaCount: 2 },
      ],
    });
    const direct = fusion.get("wiki/entities/danny-rosen.md");
    const linkedOnly = fusion.get("wiki/projects/platform.md");
    expect(direct?.ftsWeight).toBeCloseTo(600 / 61, 1);
    expect(linkedOnly?.linkedWeight).toBeCloseTo(300 / 61, 1);
    expect(linkedOnly?.linkedVia).toBe(2);
    expect((direct?.ftsWeight ?? 0) > (linkedOnly?.linkedWeight ?? 0)).toBe(
      true,
    );
  });

  test("exact-name query: the direct hit stays #1 over a never-FTS-matched linked page", () => {
    // Acceptance (docs/memory.md §M1): entity-name queries must not regress.
    // The linked-only hub even has a heavier page-type weight (project=3 vs
    // person=2); fusion alone must not let it outrank the direct hit.
    const direct = {
      path: "wiki/entities/danny-rosen.md",
      ranking: rankSearchCandidate({
        match: match({
          path: "wiki/entities/danny-rosen.md",
          rank: -3.5,
          type: "person",
        }),
        facts: [],
        diagnostics: [],
        questions: [],
        fusion: { ftsWeight: 9.84 },
      }),
    };
    const linkedHub = {
      path: "wiki/projects/platform.md",
      ranking: rankSearchCandidate({
        match: match({
          path: "wiki/projects/platform.md",
          rank: 1_000_000_000,
          type: "project",
        }),
        facts: [],
        diagnostics: [],
        questions: [],
        fusion: { linkedWeight: 4.92, linkedVia: 1 },
      }),
    };
    const sorted = [linkedHub, direct].sort(compareRankedSearchEntries);
    expect(sorted[0]?.path).toBe("wiki/entities/danny-rosen.md");
    expect(linkedHub.ranking.reasons).toContain("linked from matches");
  });
});

describe("dome.search supersession downrank", () => {
  test("superseded pages are multiplicatively downranked x0.3 with an explainable signal", () => {
    const base = rankSearchCandidate({
      match: match({ path: "wiki/concepts/old.md", rank: 2, type: "concept" }),
      facts: [fact("dome.daily.open_task")],
      diagnostics: [],
      questions: [],
    });
    const superseded = rankSearchCandidate({
      match: match({ path: "wiki/concepts/old.md", rank: 2, type: "concept" }),
      facts: [
        fact("dome.daily.open_task"),
        statusFact("superseded"),
        forwardFact("wiki/concepts/new"),
      ],
      diagnostics: [],
      questions: [],
    });

    expect(superseded.score).toBeCloseTo(base.score * 0.3, 1);
    expect(superseded.reasons).toContain("superseded by wiki/concepts/new");
    const signal = superseded.signals.find((s) => s.kind === "superseded");
    expect(signal?.label).toBe("superseded by wiki/concepts/new");
    expect(signal?.weight).toBeLessThan(0);
    // Score stays the sum of its signals.
    expect(superseded.score).toBeCloseTo(
      superseded.signals.reduce((sum, s) => sum + s.weight, 0),
      1,
    );
  });

  test("a superseded page without a forward target still explains itself", () => {
    const ranking = rankSearchCandidate({
      match: match({ path: "wiki/concepts/old.md", rank: 2, type: "concept" }),
      facts: [statusFact("superseded")],
      diagnostics: [],
      questions: [],
    });
    expect(ranking.reasons).toContain("superseded");
    expect(ranking.signals.some((s) => s.kind === "superseded")).toBe(true);
  });

  test("non-superseded status values do not downrank", () => {
    const active = rankSearchCandidate({
      match: match({ path: "wiki/entities/danny.md", rank: 2, type: "person" }),
      facts: [statusFact("active")],
      diagnostics: [],
      questions: [],
    });
    const plain = rankSearchCandidate({
      match: match({ path: "wiki/entities/danny.md", rank: 2, type: "person" }),
      facts: [],
      diagnostics: [],
      questions: [],
    });
    expect(active.score).toBe(plain.score);
    expect(active.signals.some((s) => s.kind === "superseded")).toBe(false);
  });

  test("downranked, never filtered: a superseded page still ranks and sorts", () => {
    const supersededEntry = {
      path: "wiki/concepts/old.md",
      ranking: rankSearchCandidate({
        match: match({ path: "wiki/concepts/old.md", rank: 1, type: "concept" }),
        facts: [statusFact("superseded"), forwardFact("wiki/concepts/new")],
        diagnostics: [],
        questions: [],
        fusion: { ftsWeight: 9.84 },
      }),
    };
    const liveEntry = {
      path: "wiki/concepts/new.md",
      ranking: rankSearchCandidate({
        match: match({ path: "wiki/concepts/new.md", rank: 2, type: "concept" }),
        facts: [],
        diagnostics: [],
        questions: [],
        fusion: { ftsWeight: 9.68 },
      }),
    };
    const sorted = [supersededEntry, liveEntry].sort(
      compareRankedSearchEntries,
    );
    // The live page wins the top slot, but the superseded page keeps a
    // positive score and stays in the candidate list.
    expect(sorted[0]?.path).toBe("wiki/concepts/new.md");
    expect(supersededEntry.ranking.score).toBeGreaterThan(0);
  });
});

describe("dome.search recency decay", () => {
  const NOW = new Date("2026-06-09T12:00:00.000Z");

  function fileInfo(lastHumanChangedAt: string | null): SnapshotFileInfo {
    return Object.freeze({
      lastChangedCommit: commitOid("1111111111111111111111111111111111111111"),
      lastChangedAt: NOW.toISOString(),
      lastHumanChangedAt,
    });
  }

  function entry(path: string, score: number): {
    readonly path: string;
    readonly ranking: ReturnType<typeof rankSearchCandidate>;
  } {
    return {
      path,
      ranking: Object.freeze({
        score,
        ftsRank: 0,
        recencyFactor: 1,
        reasons: Object.freeze([]),
        signals: Object.freeze([]),
      }),
    };
  }

  function hoursAgo(hours: number): string {
    return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
  }

  test("dampens stale pages multiplicatively and re-sorts", async () => {
    const infoByPath = new Map([
      ["wiki/fresh.md", fileInfo(hoursAgo(1))],
      ["wiki/stale.md", fileInfo(hoursAgo(120))], // 0.995^120 ≈ 0.548
    ]);
    const result = await applyRecencyDecay({
      entries: [entry("wiki/stale.md", 10), entry("wiki/fresh.md", 9)],
      getFileInfo: async (p) => infoByPath.get(p) ?? null,
      now: NOW,
    });
    expect(result[0]?.path).toBe("wiki/fresh.md");
    const stale = result.find((e) => e.path === "wiki/stale.md");
    expect(stale?.ranking.recencyFactor).toBeCloseTo(0.548, 2);
    expect(stale?.ranking.score).toBeCloseTo(5.48, 1);
    expect(stale?.ranking.reasons.some((r) => r.startsWith("recency decay")))
      .toBe(true);
  });

  test("floors at 0.35 — old-but-relevant pages are dampened, never buried", async () => {
    const result = await applyRecencyDecay({
      entries: [
        entry("wiki/ancient-strong.md", 20),
        entry("wiki/fresh-weak.md", 3),
      ],
      getFileInfo: async (p) =>
        p === "wiki/ancient-strong.md"
          ? fileInfo(hoursAgo(24 * 365)) // far past the floor
          : fileInfo(hoursAgo(0)),
      now: NOW,
    });
    const ancient = result.find((e) => e.path === "wiki/ancient-strong.md");
    expect(ancient?.ranking.recencyFactor).toBe(0.35);
    expect(ancient?.ranking.score).toBe(7);
    // Still ahead of the weak fresh page: dampened, not buried.
    expect(result[0]?.path).toBe("wiki/ancient-strong.md");
  });

  test("pages with only Dome-authored history are not decayed", async () => {
    const result = await applyRecencyDecay({
      entries: [entry("wiki/engine-only.md", 10)],
      getFileInfo: async () => fileInfo(null),
      now: NOW,
    });
    expect(result[0]?.ranking.score).toBe(10);
    expect(result[0]?.ranking.recencyFactor).toBe(1);
  });

  test("only the top N candidates pay a getFileInfo call", async () => {
    const calls: string[] = [];
    const entries = Array.from({ length: 5 }, (_, i) =>
      entry(`wiki/p${i}.md`, 100 - i));
    await applyRecencyDecay({
      entries,
      getFileInfo: async (p) => {
        calls.push(p);
        return fileInfo(hoursAgo(1));
      },
      now: NOW,
      topN: 2,
    });
    expect(calls.sort()).toEqual(["wiki/p0.md", "wiki/p1.md"]);
  });

  test("future timestamps clamp to no decay", async () => {
    const result = await applyRecencyDecay({
      entries: [entry("wiki/future.md", 10)],
      getFileInfo: async () => fileInfo(hoursAgo(-5)),
      now: NOW,
    });
    expect(result[0]?.ranking.score).toBe(10);
  });
});

function sectionMatch(
  path: string,
  sectionId: string,
  rank: number,
): SearchDocumentResult {
  return Object.freeze({
    ...match({ path, rank, type: null }),
    sectionId,
    breadcrumb: `${path} › ${sectionId}`,
  });
}

function linksTo(fromPath: string, target: string): {
  readonly subject: { readonly kind: "page"; readonly path: string };
  readonly predicate: string;
  readonly object: { readonly kind: "string"; readonly value: string };
} {
  return Object.freeze({
    subject: { kind: "page" as const, path: fromPath },
    predicate: "dome.graph.links_to",
    object: { kind: "string" as const, value: target },
  });
}

function match(input: {
  readonly path: string;
  readonly rank: number;
  readonly type: string | null;
}): SearchDocumentResult {
  return Object.freeze({
    path: requireVaultPath(input.path),
    sectionId: null,
    breadcrumb: null,
    category: "wiki",
    type: input.type,
    title: input.path,
    snippet: "",
    rank: input.rank,
    sourceRefs: Object.freeze([{
      path: requireVaultPath(input.path),
      commit: "1111111111111111111111111111111111111111" as CommitOid,
    }]),
  });
}

function fact(predicate: string): Pick<FactEffect, "predicate"> {
  return Object.freeze({ predicate });
}

function claimFact(claim: { readonly key: string; readonly value: string }): {
  readonly predicate: string;
  readonly object: { readonly kind: "string"; readonly value: string };
} {
  return Object.freeze({
    predicate: "dome.claims.claim",
    object: { kind: "string" as const, value: JSON.stringify(claim) },
  });
}

function statusFact(value: string): {
  readonly predicate: string;
  readonly object: { readonly kind: "string"; readonly value: string };
} {
  return Object.freeze({
    predicate: "dome.page.status",
    object: { kind: "string" as const, value },
  });
}

function forwardFact(target: string): {
  readonly predicate: string;
  readonly object: { readonly kind: "string"; readonly value: string };
} {
  return Object.freeze({
    predicate: "dome.page.superseded_by",
    object: { kind: "string" as const, value: target },
  });
}
