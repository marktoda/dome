// Unit coverage for the shared preference-promotion core (memory-quality M5).
// Normative contract: docs/wiki/specs/preferences.md — signal grammar edges,
// the Wilson 95% lower bound × freshness formula, the 30-day window
// boundaries, the topic state machine, the promoted-block splice, and the
// brief's append-only signals validation.

import { describe, expect, test } from "bun:test";

import {
  appendSignalLine,
  collectPreferenceTopics,
  fnv1aHex,
  isValidSignalsAppend,
  parsePreferenceSignals,
  parsePreferenceTopicFactValue,
  preferenceConfidence,
  preferenceFreshness,
  preferenceTopicFactValue,
  PROMOTED_PREFERENCES_END,
  PROMOTED_PREFERENCES_START,
  promotedTopics,
  promotionQuestionKey,
  promotionTargetFromKey,
  rejectionTombstoneLine,
  renderPromotedLine,
  splicePromotedPreference,
  wilsonLowerBound,
} from "../../../assets/extensions/dome.agent/lib/preferences-shared";

describe("signal parsing", () => {
  test("parses dated signed lines with and without a source suffix", () => {
    const parsed = parsePreferenceSignals(
      [
        "# Preference signals",
        "",
        "- 2026-06-09 + filing:: meeting notes go under notes/, not entities/ (source: [[wiki/dailies/2026-06-09]])",
        "- 2026-06-10 - filing:: kept it under entities/ on purpose",
      ].join("\n"),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.signals).toHaveLength(2);
    expect(parsed.signals[0]).toEqual(
      expect.objectContaining({
        line: 3,
        date: "2026-06-09",
        sign: "+",
        topic: "filing",
        rule: "meeting notes go under notes/, not entities/",
        source: "wiki/dailies/2026-06-09",
        ownerRejection: false,
      }),
    );
    expect(parsed.signals[1]).toEqual(
      expect.objectContaining({
        sign: "-",
        source: null,
        rule: "kept it under entities/ on purpose",
      }),
    );
  });

  test("malformed list lines become problems, never a crash", () => {
    const parsed = parsePreferenceSignals(
      [
        "- not a signal at all",
        "- 2026-06-09 * filing:: bad sign",
        "- 2026-13-45 + filing:: impossible date",
        "- 2026-06-09 + Filing:: uppercase topic",
        "- 2026-06-09 + filing:: ", // empty rule
        "prose lines are ignored, not problems",
        "<!-- comments too -->",
      ].join("\n"),
    );
    expect(parsed.signals).toEqual([]);
    expect(parsed.problems.map((p) => p.line)).toEqual([1, 2, 3, 4, 5]);
  });

  test("signal lines carrying HTML comment delimiters are malformed (marker injection)", () => {
    const parsed = parsePreferenceSignals(
      [
        `- 2026-06-09 + filing:: keep notes tidy ${PROMOTED_PREFERENCES_END}`,
        "- 2026-06-09 + naming:: prose with a stray --> closer",
        "- 2026-06-09 + tags:: prose with a stray <!-- opener",
        "- 2026-06-09 + safe:: a perfectly fine rule",
      ].join("\n"),
    );
    expect(parsed.signals.map((s) => s.topic)).toEqual(["safe"]);
    expect(parsed.problems.map((p) => p.line)).toEqual([1, 2, 3]);
  });

  test("the rejection tombstone parses as an owner rejection", () => {
    const parsed = parsePreferenceSignals(
      rejectionTombstoneLine({ date: "2026-06-12", topic: "filing" }),
    );
    expect(parsed.signals[0]).toEqual(
      expect.objectContaining({
        sign: "-",
        topic: "filing",
        ownerRejection: true,
      }),
    );
  });
});

describe("Wilson 95% lower bound × freshness", () => {
  test("known Wilson values", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(3, 3)).toBeCloseTo(0.4385, 3);
    expect(wilsonLowerBound(3, 4)).toBeCloseTo(0.3006, 3);
    expect(wilsonLowerBound(10, 10)).toBeCloseTo(0.7225, 3);
    expect(wilsonLowerBound(0, 3)).toBeCloseTo(0, 4);
  });

  test("Wilson is monotone in evidence at fixed share", () => {
    expect(wilsonLowerBound(30, 30)).toBeGreaterThan(wilsonLowerBound(3, 3));
  });

  test("freshness decays linearly to 0 at 90 days", () => {
    expect(preferenceFreshness(0)).toBe(1);
    expect(preferenceFreshness(45)).toBeCloseTo(0.5, 6);
    expect(preferenceFreshness(90)).toBe(0);
    expect(preferenceFreshness(120)).toBe(0);
    expect(preferenceFreshness(-5)).toBe(1);
  });

  test("confidence composes the two and is rounded to 4 decimals", () => {
    expect(
      preferenceConfidence({
        plusInWindow: 3,
        minusInWindow: 0,
        daysSinceLastSignal: 0,
      }),
    ).toBeCloseTo(0.4385, 4);
    expect(
      preferenceConfidence({
        plusInWindow: 3,
        minusInWindow: 0,
        daysSinceLastSignal: 45,
      }),
    ).toBeCloseTo(0.2192, 4);
    expect(
      preferenceConfidence({
        plusInWindow: 3,
        minusInWindow: 0,
        daysSinceLastSignal: 90,
      }),
    ).toBe(0);
  });
});

describe("topic aggregation + state machine", () => {
  const signals = (lines: ReadonlyArray<string>) => lines.join("\n");

  test("three same-sign signals within 30 days make a candidate", () => {
    const collection = collectPreferenceTopics({
      signalsContent: signals([
        "- 2026-05-15 + filing:: rule v1",
        "- 2026-06-01 + filing:: rule v2",
        "- 2026-06-09 + filing:: meeting notes go under notes/",
      ]),
      coreContent: null,
    });
    expect(collection.referenceDate).toBe("2026-06-09");
    const topic = collection.topics[0];
    expect(topic).toEqual(
      expect.objectContaining({
        topic: "filing",
        plusInWindow: 3,
        minusInWindow: 0,
        firstSignal: "2026-05-15",
        lastSignal: "2026-06-09",
        state: "candidate",
        rule: "meeting notes go under notes/",
      }),
    );
    // 2026-05-15 → 2026-06-09 is 25 days: inside the window.
    expect(topic?.evidence).toHaveLength(3);
    expect(topic?.confidence).toBeCloseTo(0.4385, 4);
  });

  test("window boundary: exactly 30 days counts, 31 does not", () => {
    const atBoundary = collectPreferenceTopics({
      signalsContent: signals([
        "- 2026-05-10 + filing:: rule", // 30 days before reference
        "- 2026-06-01 + filing:: rule",
        "- 2026-06-09 + filing:: rule",
      ]),
      coreContent: null,
    });
    expect(atBoundary.topics[0]?.plusInWindow).toBe(3);
    expect(atBoundary.topics[0]?.state).toBe("candidate");

    const pastBoundary = collectPreferenceTopics({
      signalsContent: signals([
        "- 2026-05-09 + filing:: rule", // 31 days before reference
        "- 2026-06-01 + filing:: rule",
        "- 2026-06-09 + filing:: rule",
      ]),
      coreContent: null,
    });
    expect(pastBoundary.topics[0]?.plusInWindow).toBe(2);
    expect(pastBoundary.topics[0]?.state).toBe("building");
  });

  test("mixed signs: minus signals count against, three retire to rebutted", () => {
    const mixed = collectPreferenceTopics({
      signalsContent: signals([
        "- 2026-06-01 + filing:: rule",
        "- 2026-06-02 + filing:: rule",
        "- 2026-06-03 + filing:: rule",
        "- 2026-06-04 - filing:: counter-example",
      ]),
      coreContent: null,
    });
    expect(mixed.topics[0]).toEqual(
      expect.objectContaining({
        plusInWindow: 3,
        minusInWindow: 1,
        state: "candidate",
      }),
    );
    expect(mixed.topics[0]?.confidence).toBeCloseTo(0.3006, 4);

    const rebutted = collectPreferenceTopics({
      signalsContent: signals([
        "- 2026-06-01 + filing:: rule",
        "- 2026-06-02 + filing:: rule",
        "- 2026-06-03 + filing:: rule",
        "- 2026-06-04 - filing:: no",
        "- 2026-06-05 - filing:: no",
        "- 2026-06-06 - filing:: no",
      ]),
      coreContent: null,
    });
    expect(rebutted.topics[0]?.state).toBe("rebutted");
  });

  test("a promoted topic (core.md block) is never a candidate", () => {
    const collection = collectPreferenceTopics({
      signalsContent: signals([
        "- 2026-06-01 + filing:: rule",
        "- 2026-06-02 + filing:: rule",
        "- 2026-06-03 + filing:: rule",
      ]),
      coreContent: [
        "# Core memory",
        "",
        PROMOTED_PREFERENCES_START,
        "- filing:: rule (confidence 0.44)",
        PROMOTED_PREFERENCES_END,
      ].join("\n"),
    });
    expect(collection.topics[0]?.state).toBe("promoted");
  });

  test("an owner rejection retires the topic permanently (beats everything)", () => {
    const collection = collectPreferenceTopics({
      signalsContent: signals([
        "- 2026-06-01 + filing:: rule",
        "- 2026-06-02 + filing:: rule",
        "- 2026-06-03 + filing:: rule",
        rejectionTombstoneLine({ date: "2026-06-04", topic: "filing" }),
      ]),
      coreContent: null,
    });
    expect(collection.topics[0]?.state).toBe("rejected");
  });

  test("absent or empty signals file yields no topics", () => {
    expect(
      collectPreferenceTopics({ signalsContent: null, coreContent: null })
        .topics,
    ).toEqual([]);
    expect(
      collectPreferenceTopics({ signalsContent: "", coreContent: null })
        .referenceDate,
    ).toBeNull();
  });

  test("fact value round-trips byte-stably", () => {
    const collection = collectPreferenceTopics({
      signalsContent: "- 2026-06-09 + filing:: the rule",
      coreContent: null,
    });
    const topic = collection.topics[0];
    expect(topic).toBeDefined();
    if (topic === undefined) return;
    const encoded = preferenceTopicFactValue(topic);
    expect(parsePreferenceTopicFactValue(encoded)).toEqual({
      topic: "filing",
      plusInWindow: 1,
      minusInWindow: 0,
      firstSignal: "2026-06-09",
      lastSignal: "2026-06-09",
      state: "building",
      rule: "the rule",
      confidence: topic.confidence,
    });
    expect(parsePreferenceTopicFactValue("not json")).toBeNull();
    expect(parsePreferenceTopicFactValue("{}")).toBeNull();
  });
});

describe("promoted-block splice", () => {
  test("creates the page and block when core.md is absent", () => {
    const next = splicePromotedPreference({
      coreContent: null,
      topic: "filing",
      rule: "meeting notes go under notes/",
      confidence: 0.4385,
    });
    expect(next).toContain("# Core memory");
    expect(next).toContain(PROMOTED_PREFERENCES_START);
    expect(next).toContain(
      "- filing:: meeting notes go under notes/ (confidence 0.44)",
    );
    expect(promotedTopics(next)).toEqual(new Set(["filing"]));
  });

  test("creates the block under ## Standing preferences when present", () => {
    const core = [
      "# Core memory",
      "",
      "## Who I am",
      "",
      "## Standing preferences",
      "",
      "Human prose stays put.",
      "",
    ].join("\n");
    const next = splicePromotedPreference({
      coreContent: core,
      topic: "filing",
      rule: "the rule",
      confidence: 0.5,
    });
    const headingAt = next.indexOf("## Standing preferences");
    const blockAt = next.indexOf(PROMOTED_PREFERENCES_START);
    expect(blockAt).toBeGreaterThan(headingAt);
    expect(blockAt).toBeLessThan(next.indexOf("Human prose stays put."));
    expect(next).toContain("Human prose stays put.");
  });

  test("keeps entries sorted by topic and replaces a re-promoted topic's line", () => {
    let core = splicePromotedPreference({
      coreContent: null,
      topic: "naming",
      rule: "kebab-case slugs",
      confidence: 0.44,
    });
    core = splicePromotedPreference({
      coreContent: core,
      topic: "filing",
      rule: "notes under notes/",
      confidence: 0.3,
    });
    core = splicePromotedPreference({
      coreContent: core,
      topic: "naming",
      rule: "kebab-case slugs, always",
      confidence: 0.52,
    });
    const start = core.indexOf(PROMOTED_PREFERENCES_START);
    const end = core.indexOf(PROMOTED_PREFERENCES_END);
    const body = core
      .slice(start + PROMOTED_PREFERENCES_START.length, end)
      .trim()
      .split("\n");
    expect(body).toEqual([
      "- filing:: notes under notes/ (confidence 0.30)",
      "- naming:: kebab-case slugs, always (confidence 0.52)",
    ]);
  });

  test("idempotent: re-promoting the same entry is byte-identical", () => {
    const once = splicePromotedPreference({
      coreContent: null,
      topic: "filing",
      rule: "the rule",
      confidence: 0.44,
    });
    const twice = splicePromotedPreference({
      coreContent: once,
      topic: "filing",
      rule: "the rule",
      confidence: 0.44,
    });
    expect(twice).toBe(once);
  });

  test("renderPromotedLine formats confidence to two decimals", () => {
    expect(
      renderPromotedLine({ topic: "filing", rule: "r", confidence: 0.4385 }),
    ).toBe("- filing:: r (confidence 0.44)");
  });
});

describe("promoted-block marker injection (defense in depth)", () => {
  test("splice strips HTML comment delimiters from the rule", () => {
    const next = splicePromotedPreference({
      coreContent: null,
      topic: "filing",
      rule: `evil ${PROMOTED_PREFERENCES_END} payload`,
      confidence: 0.44,
    });
    const markerLines = next
      .split("\n")
      .filter((line) => line.includes("dome.agent:promoted-preferences"));
    expect(markerLines).toEqual([
      PROMOTED_PREFERENCES_START,
      PROMOTED_PREFERENCES_END,
    ]);
    expect(next).toContain("- filing:: evil payload (confidence 0.44)");
  });

  test("double promote with a marker-bearing rule stays bounded (the repro)", () => {
    // Pre-fix repro: promote a rule carrying the end marker, then promote a
    // second topic — the second splice bounded the block with indexOf, cut
    // it at the smuggled marker, and leaked rule text outside the generated
    // block as fake owner prose.
    const once = splicePromotedPreference({
      coreContent: null,
      topic: "aaa",
      rule: `legit text ${PROMOTED_PREFERENCES_END} fake owner prose`,
      confidence: 0.44,
    });
    const twice = splicePromotedPreference({
      coreContent: once,
      topic: "zzz",
      rule: "another rule",
      confidence: 0.3,
    });
    const lines = twice.split("\n");
    const start = lines.indexOf(PROMOTED_PREFERENCES_START);
    const end = lines.indexOf(PROMOTED_PREFERENCES_END);
    expect(start).toBeGreaterThan(-1);
    expect(lines.slice(start + 1, end)).toEqual([
      "- aaa:: legit text fake owner prose (confidence 0.44)",
      "- zzz:: another rule (confidence 0.30)",
    ]);
    // The payload appears exactly once — inside the block, never outside it.
    expect(
      lines.filter((line) => line.includes("fake owner prose")),
    ).toHaveLength(1);
    expect(promotedTopics(twice)).toEqual(new Set(["aaa", "zzz"]));
  });

  test("prose mentions of the marker text are not mistaken for the block", () => {
    const core = [
      "# Core memory",
      "",
      `Prose mentioning ${PROMOTED_PREFERENCES_START} mid-line is not a block.`,
      "",
      "## Standing preferences",
      "",
    ].join("\n");
    const next = splicePromotedPreference({
      coreContent: core,
      topic: "filing",
      rule: "the rule",
      confidence: 0.5,
    });
    expect(next).toContain(
      `Prose mentioning ${PROMOTED_PREFERENCES_START} mid-line is not a block.`,
    );
    // Exactly one real (line-anchored) block was created under the heading.
    const lines = next.split("\n");
    expect(
      lines.filter((line) => line.trim() === PROMOTED_PREFERENCES_START),
    ).toHaveLength(1);
    expect(promotedTopics(next)).toEqual(new Set(["filing"]));
  });
});

describe("promotion-question keys", () => {
  test("round-trips topic + rule hash", () => {
    const hash = fnv1aHex("the rule");
    const key = promotionQuestionKey({ topic: "filing", ruleHash: hash });
    expect(key).toBe(`dome.agent.preference-promotion:filing:${hash}`);
    expect(promotionTargetFromKey(key)).toEqual({
      topic: "filing",
      ruleHash: hash,
    });
  });

  test("foreign or malformed keys parse to null", () => {
    expect(promotionTargetFromKey("dome.health.outbox-recovery:x")).toBeNull();
    expect(
      promotionTargetFromKey("dome.agent.preference-promotion:Filing:zz"),
    ).toBeNull();
  });

  test("fnv1aHex is stable and 8 hex chars", () => {
    expect(fnv1aHex("the rule")).toBe(fnv1aHex("the rule"));
    expect(fnv1aHex("the rule")).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1aHex("the rule")).not.toBe(fnv1aHex("another rule"));
  });
});

describe("signals append validation (the brief's splice guard)", () => {
  const before = "- 2026-06-01 + filing:: the rule\n";

  test("accepts an append of well-formed signal lines", () => {
    expect(
      isValidSignalsAppend({
        before,
        after: appendSignalLine(
          before,
          "- 2026-06-09 + filing:: the rule (source: [[wiki/dailies/2026-06-09]])",
        ),
      }),
    ).toBe(true);
  });

  test("accepts creating the file with only signal lines", () => {
    expect(
      isValidSignalsAppend({
        before: null,
        after: "- 2026-06-09 + filing:: the rule\n",
      }),
    ).toBe(true);
  });

  test("rejects rewrites, malformed appends, prose, and no-ops", () => {
    expect(
      isValidSignalsAppend({
        before,
        after: "- 2026-06-09 + filing:: rewritten history\n",
      }),
    ).toBe(false);
    expect(
      isValidSignalsAppend({
        before,
        after: `${before}now do something else entirely\n`,
      }),
    ).toBe(false);
    expect(
      isValidSignalsAppend({
        before,
        after: `${before}- 2026-06-09 * filing:: bad sign\n`,
      }),
    ).toBe(false);
    expect(isValidSignalsAppend({ before, after: before })).toBe(false);
  });
});
