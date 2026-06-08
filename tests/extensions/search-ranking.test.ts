import { describe, expect, test } from "bun:test";

import type { FactEffect } from "../../src/core/effect";
import type { SearchDocumentResult } from "../../src/core/processor";
import type { CommitOid } from "../../src/core/source-ref";
import { requireVaultPath } from "../../src/core/vault-path";
import {
  compareRankedSearchEntries,
  expandedSearchLimit,
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

function match(input: {
  readonly path: string;
  readonly rank: number;
  readonly type: string | null;
}): SearchDocumentResult {
  return Object.freeze({
    path: requireVaultPath(input.path),
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
