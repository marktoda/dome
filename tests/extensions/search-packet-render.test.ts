// dome.search/packet-render — unit tests for the markdown rendering layer.
//
// Coverage:
//   1. Ranking telemetry (score/fts) is suppressed; qualitative Relevance: appears.
//   2. Facts list is capped with a "… and N more (see --json)" affordance.
//   3. Structural sections (## Read First, ## Matches) are preserved.
//   4. Recency-decay telemetry is filtered from Relevance: and ## Read First at render
//      time; the raw ranking.reasons (including recency decay) is untouched for --json.

import { describe, expect, test } from "bun:test";

import { renderMarkdown } from "../../assets/extensions/dome.search/processors/packet-render";
import type {
  ContextEntry,
  ContextOverview,
} from "../../assets/extensions/dome.search/processors/export-context";
import { commitOid, sourceRef } from "../../src/core/source-ref";

const HEAD_COMMIT = commitOid("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

function makeRef(path: string) {
  return sourceRef({ commit: HEAD_COMMIT, path });
}

// A minimal SearchRanking-shaped object with realistic fields.
function makeRanking(opts: {
  reasons: string[];
  score: number;
  ftsRank: number;
}) {
  return Object.freeze({
    score: opts.score,
    ftsRank: opts.ftsRank,
    reasons: Object.freeze(opts.reasons),
    recencyFactor: 1,
    signals: Object.freeze([]),
  });
}

function makeFact(predicate: string, object: string) {
  return Object.freeze({
    predicate,
    object,
    assertion: "explicit" as const,
    sourceRefs: Object.freeze([makeRef("wiki/page.md")]),
  });
}

// Build a ContextEntry with many facts so the cap / overflow line is triggered.
const MANY_FACTS = Array.from({ length: 12 }, (_, i) =>
  makeFact(`dome.attr.fact_${i}`, `value ${i}`),
);

const ENTRY: ContextEntry = Object.freeze({
  path: "wiki/adoption-loop.md",
  title: "Adoption Loop",
  category: "wiki",
  type: null,
  sectionId: null,
  breadcrumb: null,
  snippet: "The adoption loop is the core growth mechanism.",
  rank: -1,
  ranking: makeRanking({
    // NOTE: includes recency decay to exercise the render-time filter.
    reasons: ["text match", "6 linked from matches", "matrix page", "recency decay x0.98"],
    score: 16.14,
    ftsRank: -4.17477137234649,
  }),
  sourceRefs: Object.freeze([makeRef("wiki/adoption-loop.md")]),
  summary: Object.freeze([]),
  facts: Object.freeze(MANY_FACTS),
  allFacts: Object.freeze(MANY_FACTS),
  factCount: MANY_FACTS.length,
  diagnostics: Object.freeze([]),
  allDiagnostics: Object.freeze([]),
  diagnosticCount: 0,
  questions: Object.freeze([]),
  allQuestions: Object.freeze([]),
  questionCount: 0,
});

const OVERVIEW: ContextOverview = Object.freeze({
  readFirst: Object.freeze([
    Object.freeze({
      path: "wiki/adoption-loop.md",
      title: "Adoption Loop",
      // This mirrors what readFirstReason() in export-context.ts produces:
      // joins [matches "topic", ...ranking.reasons] with "; " — recency decay is present.
      reason: 'matches "adoption loop"; text match; 6 linked from matches; matrix page; recency decay x0.98',
      rank: -1,
      ranking: ENTRY.ranking,
      sourceRefs: ENTRY.sourceRefs,
    }),
  ]),
  claims: Object.freeze([]),
  openLoops: Object.freeze([]),
  decisions: Object.freeze([]),
  unresolvedQuestions: Object.freeze([]),
  diagnostics: Object.freeze([]),
  recallSignals: Object.freeze([]),
});

describe("packet-render markdown output", () => {
  const rendered = renderMarkdown("adoption loop", OVERVIEW, [ENTRY], false);

  test("does NOT contain raw score number in parenthetical form", () => {
    expect(rendered).not.toMatch(/\(score\s/);
  });

  test("does NOT contain fts rank value", () => {
    expect(rendered).not.toContain("fts ");
  });

  test("does NOT contain ftsRank label", () => {
    expect(rendered).not.toContain("ftsRank");
  });

  test("emits a Relevance: line with qualitative reasons", () => {
    expect(rendered).toMatch(/- Relevance:/);
  });

  test("Relevance line contains the reason phrases", () => {
    expect(rendered).toMatch(/Relevance:.*text match/);
    expect(rendered).toMatch(/Relevance:.*matrix page/);
  });

  test("Relevance line does NOT include the numeric score", () => {
    const relevanceLine = rendered
      .split("\n")
      .find((line) => line.startsWith("- Relevance:"));
    expect(relevanceLine).toBeDefined();
    expect(relevanceLine).not.toMatch(/16\.14/);
    expect(relevanceLine).not.toMatch(/-4\.17/);
  });

  test("facts list is capped with '… and N more LABEL (see --json)' affordance when facts exceed cap", () => {
    // 12 facts total; the cap should trigger an overflow line.
    expect(rendered).toMatch(/… and \d+ more \w+ \(see --json\)/);
  });

  test("overflow line references the correct remaining count", () => {
    // MAX_RELATED_ROWS is 8 in packet-render; 12 - 8 = 4 remaining.
    expect(rendered).toContain("… and 4 more facts (see --json)");
  });

  test("## Read First section is present", () => {
    expect(rendered).toContain("## Read First");
  });

  test("## Matches section is present", () => {
    expect(rendered).toContain("## Matches");
  });

  test("entry Path is present", () => {
    expect(rendered).toContain("- Path: `wiki/adoption-loop.md`");
  });

  // Recency decay filter tests — the raw reasons array carries it (for --json), but
  // markdown rendering must suppress it from both the Relevance: line and Read First.
  test("Relevance line does NOT contain recency decay", () => {
    const relevanceLine = rendered
      .split("\n")
      .find((line) => line.startsWith("- Relevance:"));
    expect(relevanceLine).toBeDefined();
    expect(relevanceLine).not.toMatch(/recency decay/i);
  });

  test("Relevance line still contains qualitative reasons after decay filter", () => {
    expect(rendered).toMatch(/Relevance:.*text match/);
    expect(rendered).toMatch(/Relevance:.*matrix page/);
  });

  test("## Read First line does NOT contain recency decay", () => {
    const readFirstLines = rendered
      .split("\n")
      .filter((line) => /^\d+\. `/.test(line));
    expect(readFirstLines.length).toBeGreaterThan(0);
    for (const line of readFirstLines) {
      expect(line).not.toMatch(/recency decay/i);
    }
  });

  test("## Read First line still contains qualitative reasons", () => {
    const readFirstLines = rendered
      .split("\n")
      .filter((line) => /^\d+\. `/.test(line));
    expect(readFirstLines.length).toBeGreaterThan(0);
    // At least one of the qualitative reasons should appear in the parenthetical.
    const combined = readFirstLines.join(" ");
    expect(combined).toMatch(/text match|matrix page/i);
  });

  test("raw ranking.reasons still contains recency decay (--json data layer intact)", () => {
    // Confirm the structured data carries the full reasons; only the render is filtered.
    expect(ENTRY.ranking.reasons).toContain("recency decay x0.98");
    expect(OVERVIEW.readFirst[0]!.reason).toMatch(/recency decay/);
  });
});
