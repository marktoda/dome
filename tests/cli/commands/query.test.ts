// `dome query` — human-output rendering tests.
//
// These tests exercise `formatQueryResult` directly (exported for testing),
// building fixture data in-process without a real vault. The goal is to
// confirm that the human renderer:
//   - uses the `match` primitive (numbered rank, right-aligned path,
//     breadcrumb, snippet, sourceRef),
//   - drops telemetry (why:/score/fts/facts:) from human output,
//   - emits a compact summary line instead of the legacy QUERY kv block.

import { describe, expect, test } from "bun:test";

import {
  formatQueryResult,
} from "../../../src/cli/commands/query";
import { resolveCaps } from "../../../src/cli/presenter";

// A caps instance with no color / unicode (mirrors the non-TTY test env).
const CAPS = resolveCaps();

// Minimal fixture data shape matching what `parseQueryResult` expects.
function makeQueryData(overrides: {
  query?: string;
  shown?: number;
  hasMore?: boolean;
  limit?: number | null;
  matches?: unknown[];
}) {
  return {
    query: overrides.query ?? "capability broker",
    shown: { matches: overrides.shown ?? (overrides.matches?.length ?? 1) },
    hasMore: { matches: overrides.hasMore ?? false },
    limit: overrides.limit ?? null,
    matches: overrides.matches ?? [],
  };
}

const MATCH_WITH_TELEMETRY = {
  path: "wiki/capability-broker.md",
  title: "Capability Broker",
  breadcrumb: "Architecture › Capability Broker",
  snippet: "[capability] [broker] resolves service requests",
  ranking: {
    score: 0.92,
    ftsRank: 0.88,
    reasons: ["keyword-match", "title-hit"],
    signals: [],
  },
  sourceRefs: [
    {
      path: "wiki/capability-broker.md",
      commit: "abc1234def5678",
      range: { startLine: 1, endLine: 5 },
    },
  ],
  facts: [
    { predicate: "dome.page.capability" },
    { predicate: "dome.page.architecture" },
  ],
  diagnostics: [],
  questions: [],
};

describe("formatQueryResult — human renderer", () => {
  test("renders rank + title and right-aligned path", () => {
    const data = makeQueryData({ matches: [MATCH_WITH_TELEMETRY] });
    const out = formatQueryResult(data, CAPS);
    // The match primitive renders "  1  <title>" followed by the path
    expect(out).toContain("1");
    expect(out).toContain("Capability Broker");
    expect(out).toContain("wiki/capability-broker.md");
  });

  test("renders breadcrumb line with › prefix", () => {
    const data = makeQueryData({ matches: [MATCH_WITH_TELEMETRY] });
    const out = formatQueryResult(data, CAPS);
    // breadcrumb is different from title — should appear
    expect(out).toContain("›");
    expect(out).toContain("Architecture");
  });

  test("renders snippet text (FTS markers stripped)", () => {
    const data = makeQueryData({ matches: [MATCH_WITH_TELEMETRY] });
    const out = formatQueryResult(data, CAPS);
    // FTS markers [ and ] should be stripped; text should appear
    expect(out).toContain("capability");
    expect(out).toContain("broker");
    expect(out).toContain("resolves service requests");
    // No raw FTS markers in output
    expect(out).not.toContain("[capability]");
    expect(out).not.toContain("[broker]");
  });

  test("renders sourceRef in compact format", () => {
    const data = makeQueryData({ matches: [MATCH_WITH_TELEMETRY] });
    const out = formatQueryResult(data, CAPS);
    // formatSourceRef => "wiki/capability-broker.md:1-5 @ abc1234"
    expect(out).toContain("abc1234");
  });

  test("does NOT render why:, score, fts, or facts: telemetry", () => {
    const data = makeQueryData({ matches: [MATCH_WITH_TELEMETRY] });
    const out = formatQueryResult(data, CAPS);
    expect(out).not.toContain("why:");
    expect(out).not.toContain("score");
    expect(out).not.toContain("fts");
    expect(out).not.toContain("facts:");
    expect(out).not.toContain("keyword-match");
    expect(out).not.toContain("title-hit");
    expect(out).not.toContain("dome.page.capability");
  });

  test("summary line — no hasMore: shows N match/matches", () => {
    const data = makeQueryData({
      query: "capability broker",
      matches: [MATCH_WITH_TELEMETRY],
      hasMore: false,
    });
    const out = formatQueryResult(data, CAPS);
    // Should have a compact summary, not the old QUERY kv block
    expect(out).not.toContain("text:");
    expect(out).not.toContain("shown:");
    expect(out).not.toContain("limit:");
    expect(out).not.toContain("has more:");
    // Summary line
    expect(out).toContain("1 match");
    expect(out).toContain('"capability broker"');
  });

  test("summary line — hasMore: shows 'showing N, raise with --limit'", () => {
    const data = makeQueryData({
      query: "capability broker",
      shown: 5,
      hasMore: true,
      matches: Array(5).fill(MATCH_WITH_TELEMETRY),
    });
    const out = formatQueryResult(data, CAPS);
    expect(out).toContain("showing 5");
    expect(out).toContain("--limit");
    expect(out).toContain('"capability broker"');
  });

  test("multiple matches are numbered", () => {
    const data = makeQueryData({
      matches: [
        MATCH_WITH_TELEMETRY,
        {
          ...MATCH_WITH_TELEMETRY,
          title: "Second Match",
          path: "wiki/second.md",
          breadcrumb: null,
          snippet: "",
          sourceRefs: [],
          facts: [],
        },
      ],
    });
    const out = formatQueryResult(data, CAPS);
    expect(out).toContain("Capability Broker");
    expect(out).toContain("Second Match");
    // Both match numbers should appear
    expect(out).toMatch(/\b1\b/);
    expect(out).toMatch(/\b2\b/);
  });

  test("breadcrumb strips leading '<title> › ' prefix", () => {
    // When breadcrumb starts with the title followed by ' › ', only the section
    // path after the prefix is rendered — the title is already shown on its own line.
    const matchWithLeadingTitle = {
      ...MATCH_WITH_TELEMETRY,
      title: "Effect router targets",
      breadcrumb: "Effect router targets › Phase compatibility precedes capability enforcement",
    };
    const data = makeQueryData({ matches: [matchWithLeadingTitle] });
    const out = formatQueryResult(data, CAPS);
    // The section after the title prefix should appear
    expect(out).toContain("Phase compatibility precedes capability enforcement");
    // The title should NOT be repeated as a leading breadcrumb segment
    // (i.e. "Effect router targets ›" should not appear in the breadcrumb line)
    // The title itself appears as the match title, so we check the breadcrumb
    // line does not re-prefix with the title:
    const lines = out.split("\n");
    const breadcrumbLine = lines.find((l) => l.includes("›"));
    expect(breadcrumbLine).toBeDefined();
    // The breadcrumb line must NOT contain "Effect router targets ›" (the stripped prefix)
    expect(breadcrumbLine).not.toContain("Effect router targets ›");
  });

  test("breadcrumb without leading title prefix is unchanged", () => {
    // When breadcrumb does not start with '<title> › ', it passes through unmodified.
    const data = makeQueryData({ matches: [MATCH_WITH_TELEMETRY] });
    const out = formatQueryResult(data, CAPS);
    // MATCH_WITH_TELEMETRY breadcrumb is "Architecture › Capability Broker" —
    // title is "Capability Broker", so no leading-title stripping applies.
    expect(out).toContain("Architecture");
    expect(out).toContain("Capability Broker");
  });

  test("n === 0 empty state emits muted 'no matches'", () => {
    const data = makeQueryData({ matches: [] });
    const out = formatQueryResult(data, CAPS);
    expect(out).toContain("no matches");
    expect(out).not.toContain("why:");
    expect(out).not.toContain("facts:");
  });
});
