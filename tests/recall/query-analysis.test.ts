import { describe, expect, test } from "bun:test";

import {
  analyzeRecallQuery,
  matchesRecallText,
} from "../../src/recall/query-analysis";

describe("natural-language recall query analysis", () => {
  test("removes question and answer-shape words while retaining evidence terms", () => {
    const query = analyzeRecallQuery(
      "What was the outcome of Alice Chen's promotion?",
    );
    expect(query.terms).toEqual(["alice", "chen", "promotion"]);
    expect(query.minimumShouldMatch).toBe(2);
    expect(query.fts).toContain(" OR ");
  });

  test("requires both terms for a focused two-term query", () => {
    const query = analyzeRecallQuery("flux capacitor");
    expect(query.minimumShouldMatch).toBe(2);
    expect(query.fts).toBe('"flux" "capacitor"');
  });

  test("keeps intent words when they are the whole query", () => {
    expect(analyzeRecallQuery("open threads").terms).toEqual(["open", "threads"]);
  });

  test("projection-memory matching uses the same minimum-match semantics", () => {
    expect(
      matchesRecallText(
        "What are Maya's compensation priorities and open threads?",
        "Maya compensation review is scheduled for Friday.",
      ),
    ).toBe(true);
    expect(
      matchesRecallText(
        "What are Maya's compensation priorities and open threads?",
        "Unrelated open project thread.",
      ),
    ).toBe(false);
  });
});
