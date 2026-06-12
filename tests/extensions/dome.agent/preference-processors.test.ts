// Unit coverage for the three M5 preference processors
// (docs/wiki/specs/preferences.md): the deterministic counter
// (dome.agent.preference-signals), the promotion question emitter
// (dome.agent.preference-promotion), and the answer handler
// (dome.agent.preference-promotion-answer — the gated core.md writer that
// owns the promoted-preferences block; preferences.md §two-gated-writers).

import { describe, expect, test } from "bun:test";

import preferencePromotion from "../../../assets/extensions/dome.agent/processors/preference-promotion";
import preferencePromotionAnswer from "../../../assets/extensions/dome.agent/processors/preference-promotion-answer";
import preferenceSignals from "../../../assets/extensions/dome.agent/processors/preference-signals";
import {
  demotionQuestionKey,
  fnv1aHex,
  parsePreferenceTopicFactValue,
  PROMOTED_PREFERENCES_END,
  PROMOTED_PREFERENCES_START,
  promotionQuestionKey,
  rejectionTombstoneLine,
} from "../../../assets/extensions/dome.agent/lib/preferences-shared";
import type {
  DiagnosticEffect,
  Effect,
  FactEffect,
  PatchEffect,
  QuestionEffect,
} from "../../../src/core/effect";
import { treeOid, type Snapshot } from "../../../src/core/processor";
import { makeManualProposal } from "../../../src/core/proposal";
import { commitOid } from "../../../src/core/source-ref";
import { makeProcessorContext } from "../../../src/processors/context";

const HEAD_COMMIT = commitOid("4444444444444444444444444444444444444444");

const THREE_PLUS = [
  "- 2026-06-01 + filing:: meeting notes go under notes/ (source: [[wiki/dailies/2026-06-01]])",
  "- 2026-06-05 + filing:: meeting notes go under notes/",
  "- 2026-06-09 + filing:: meeting notes go under notes/, not entities/",
].join("\n");
const CANDIDATE_RULE = "meeting notes go under notes/, not entities/";

function run(
  processor: { run: (ctx: never) => Promise<ReadonlyArray<Effect>> },
  opts: {
    readonly files?: Readonly<Record<string, string>>;
    readonly input?: unknown;
  },
): Promise<ReadonlyArray<Effect>> {
  const files = opts.files ?? {};
  const snapshot: Snapshot = Object.freeze({
    commit: HEAD_COMMIT,
    tree: treeOid("5555555555555555555555555555555555555555"),
    readFile: async (path: string) => files[path] ?? null,
    listMarkdownFiles: async () => Object.freeze(Object.keys(files)),
    getFileInfo: async () => null,
  });
  const ctx = makeProcessorContext({
    snapshot,
    changedPaths: Object.freeze(Object.keys(files)),
    proposal: makeManualProposal({
      base: HEAD_COMMIT,
      head: HEAD_COMMIT,
      branch: "main",
    }),
    runId: "run-preference-test",
    signal: new AbortController().signal,
    input: opts.input ?? { kind: "garden", matchedTriggers: [] },
  });
  return processor.run(ctx as never);
}

describe("dome.agent.preference-signals (counter facts)", () => {
  test("emits one dome.preference.topic fact per topic", async () => {
    const effects = await run(preferenceSignals, {
      files: {
        "preferences/signals.md": [
          THREE_PLUS,
          "- 2026-06-08 + naming:: kebab-case slugs",
        ].join("\n"),
      },
    });
    const facts = effects.filter((e): e is FactEffect => e.kind === "fact");
    expect(facts).toHaveLength(2);
    expect(facts.every((f) => f.predicate === "dome.preference.topic")).toBe(
      true,
    );
    const filing = facts
      .map((f) =>
        f.object.kind === "string"
          ? parsePreferenceTopicFactValue(f.object.value)
          : null,
      )
      .find((value) => value?.topic === "filing");
    expect(filing).toEqual(
      expect.objectContaining({
        plusInWindow: 3,
        minusInWindow: 0,
        state: "candidate",
        rule: CANDIDATE_RULE,
      }),
    );
  });

  test("promoted block in core.md flips the state and no question state leaks", async () => {
    const effects = await run(preferenceSignals, {
      files: {
        "preferences/signals.md": THREE_PLUS,
        "core.md": [
          "# Core memory",
          PROMOTED_PREFERENCES_START,
          `- filing:: ${CANDIDATE_RULE} (confidence 0.44)`,
          PROMOTED_PREFERENCES_END,
        ].join("\n"),
      },
    });
    const fact = effects.find((e): e is FactEffect => e.kind === "fact");
    const value =
      fact?.object.kind === "string"
        ? parsePreferenceTopicFactValue(fact.object.value)
        : null;
    expect(value?.state).toBe("promoted");
  });

  test("malformed lines yield ONE info diagnostic, never a crash", async () => {
    const effects = await run(preferenceSignals, {
      files: {
        "preferences/signals.md": [
          "- garbage line",
          "- 2026-06-09 * filing:: bad sign",
          "- 2026-06-09 + filing:: a good line",
        ].join("\n"),
      },
    });
    const diagnostics = effects.filter(
      (e): e is DiagnosticEffect => e.kind === "diagnostic",
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({
        severity: "info",
        code: "dome.agent.preference-signals.malformed-lines",
      }),
    );
    expect(diagnostics[0]?.message).toContain("lines 1, 2");
    expect(effects.filter((e) => e.kind === "fact")).toHaveLength(1);
  });

  test("absent signals page emits nothing", async () => {
    expect(await run(preferenceSignals, { files: {} })).toEqual([]);
  });

  test("deterministic: same snapshot, byte-identical facts", async () => {
    const files = { "preferences/signals.md": THREE_PLUS };
    const first = await run(preferenceSignals, { files });
    const second = await run(preferenceSignals, { files });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("dome.agent.preference-promotion (questions)", () => {
  test("a candidate topic raises one owner-needed question with quoted evidence", async () => {
    const effects = await run(preferencePromotion, {
      files: { "preferences/signals.md": THREE_PLUS },
    });
    const questions = effects.filter(
      (e): e is QuestionEffect => e.kind === "question",
    );
    expect(questions).toHaveLength(1);
    const question = questions[0];
    expect(question?.idempotencyKey).toBe(
      promotionQuestionKey({
        topic: "filing",
        ruleHash: fnv1aHex(CANDIDATE_RULE),
      }),
    );
    expect(question?.options).toEqual(["promote", "reject"]);
    expect(question?.question).toContain(CANDIDATE_RULE);
    // Evidence lines quoted verbatim.
    expect(question?.question).toContain(
      "- 2026-06-01 + filing:: meeting notes go under notes/ (source: [[wiki/dailies/2026-06-01]])",
    );
    expect(question?.metadata).toEqual(
      expect.objectContaining({
        automationPolicy: "owner-needed",
        confidence: 0.4385,
      }),
    );
    // One sourceRef per evidence line, pointing at the signals page.
    expect(question?.sourceRefs).toHaveLength(3);
    expect(question?.sourceRefs.every((ref) => ref.path === "preferences/signals.md")).toBe(true);
  });

  test("question text renders evidence inert — indented, never column-0 list lines", async () => {
    // Promotion questions are rendered into markdown surfaces (the brief's
    // open-questions block, `dome check` output). Quoted evidence must not
    // read as live top-level list/signal lines there: every quoted raw line
    // is indented, so it renders as continuation text, not as a bullet.
    const effects = await run(preferencePromotion, {
      files: { "preferences/signals.md": THREE_PLUS },
    });
    const question = effects.find(
      (e): e is QuestionEffect => e.kind === "question",
    );
    expect(question).toBeDefined();
    const lines = (question?.question ?? "").split("\n");
    const evidence = lines.filter((line) => line.includes("filing::"));
    expect(evidence).toHaveLength(3);
    for (const line of evidence) {
      expect(line).toMatch(/^\s+- \d{4}-\d{2}-\d{2} /);
    }
    // Nothing in the question text is a column-0 `- ` list line.
    expect(lines.some((line) => line.startsWith("- "))).toBe(false);
  });

  test("stays quiet for building, rebutted, rejected, and promoted topics", async () => {
    const cases: ReadonlyArray<Readonly<Record<string, string>>> = [
      // building: only two in-window signals
      {
        "preferences/signals.md": [
          "- 2026-06-05 + filing:: rule",
          "- 2026-06-09 + filing:: rule",
        ].join("\n"),
      },
      // rebutted: three minus signals in window
      {
        "preferences/signals.md": [
          THREE_PLUS,
          "- 2026-06-06 - filing:: no",
          "- 2026-06-07 - filing:: no",
          "- 2026-06-08 - filing:: no",
        ].join("\n"),
      },
      // rejected: owner tombstone
      {
        "preferences/signals.md": [
          THREE_PLUS,
          rejectionTombstoneLine({ date: "2026-06-10", topic: "filing" }),
        ].join("\n"),
      },
      // promoted: core.md block already carries the topic
      {
        "preferences/signals.md": THREE_PLUS,
        "core.md": [
          PROMOTED_PREFERENCES_START,
          `- filing:: ${CANDIDATE_RULE} (confidence 0.44)`,
          PROMOTED_PREFERENCES_END,
        ].join("\n"),
      },
    ];
    for (const files of cases) {
      const effects = await run(preferencePromotion, { files });
      expect(effects.filter((e) => e.kind === "question")).toEqual([]);
    }
  });

  test("window boundary: a signal 31 days old does not gate promotion in", async () => {
    const effects = await run(preferencePromotion, {
      files: {
        "preferences/signals.md": [
          "- 2026-05-09 + filing:: rule", // 31 days before the 06-09 reference
          "- 2026-06-01 + filing:: rule",
          "- 2026-06-09 + filing:: rule",
        ].join("\n"),
      },
    });
    expect(effects.filter((e) => e.kind === "question")).toEqual([]);
  });

  test("a promoted topic with decayed confidence raises one owner-needed demotion question", async () => {
    // filing's signals are months older than the file's reference date (the
    // newest signal anywhere — naming's), so freshness is 0 → confidence 0.
    const effects = await run(preferencePromotion, {
      files: {
        "preferences/signals.md": [
          "- 2026-01-01 + filing:: meeting notes go under notes/",
          "- 2026-01-05 + filing:: meeting notes go under notes/",
          `- 2026-01-09 + filing:: ${CANDIDATE_RULE}`,
          "- 2026-06-09 + naming:: kebab-case slugs",
        ].join("\n"),
        "core.md": [
          "# Core memory",
          PROMOTED_PREFERENCES_START,
          `- filing:: ${CANDIDATE_RULE} (confidence 0.44)`,
          PROMOTED_PREFERENCES_END,
        ].join("\n"),
      },
    });
    const questions = effects.filter(
      (e): e is QuestionEffect => e.kind === "question",
    );
    expect(questions).toHaveLength(1);
    const question = questions[0];
    expect(question?.idempotencyKey).toBe(
      demotionQuestionKey({
        topic: "filing",
        ruleHash: fnv1aHex(CANDIDATE_RULE),
      }),
    );
    expect(question?.options).toEqual(["demote", "keep"]);
    expect(question?.question).toContain(CANDIDATE_RULE);
    expect(question?.metadata).toEqual(
      expect.objectContaining({
        automationPolicy: "owner-needed",
        recommendedAnswer: "demote",
        confidence: 0,
      }),
    );
    // The promoted block's core.md line anchors the question; no in-window
    // signals exist, so it is the only sourceRef.
    expect(question?.sourceRefs).toHaveLength(1);
    expect(String(question?.sourceRefs[0]?.path)).toBe("core.md");
    expect(question?.sourceRefs[0]?.range?.startLine).toBe(3);
  });

  test("the demotion key hashes the PROMOTED BLOCK's rule text, not the latest signal's", async () => {
    const effects = await run(preferencePromotion, {
      files: {
        "preferences/signals.md": [
          "- 2026-01-09 + filing:: a newer different wording",
          "- 2026-06-09 + naming:: kebab-case slugs",
        ].join("\n"),
        "core.md": [
          PROMOTED_PREFERENCES_START,
          `- filing:: ${CANDIDATE_RULE} (confidence 0.44)`,
          PROMOTED_PREFERENCES_END,
        ].join("\n"),
      },
    });
    const question = effects.find(
      (e): e is QuestionEffect => e.kind === "question",
    );
    expect(question?.idempotencyKey).toBe(
      demotionQuestionKey({
        topic: "filing",
        ruleHash: fnv1aHex(CANDIDATE_RULE),
      }),
    );
  });

  test("decayed-but-promoted with in-window counter-evidence quotes the evidence inert", async () => {
    // 1 plus vs 2 minus in window: Wilson(1,3) ≈ 0.0615 < 0.15 with freshness
    // 1.0 — Wilson alone can trigger demotion, not just staleness.
    const effects = await run(preferencePromotion, {
      files: {
        "preferences/signals.md": [
          `- 2026-06-05 + filing:: ${CANDIDATE_RULE}`,
          "- 2026-06-07 - filing:: kept it under entities/ on purpose",
          "- 2026-06-09 - filing:: again, entities/ was right",
        ].join("\n"),
        "core.md": [
          PROMOTED_PREFERENCES_START,
          `- filing:: ${CANDIDATE_RULE} (confidence 0.44)`,
          PROMOTED_PREFERENCES_END,
        ].join("\n"),
      },
    });
    const question = effects.find(
      (e): e is QuestionEffect => e.kind === "question",
    );
    expect(question).toBeDefined();
    expect(question?.metadata?.confidence).toBeGreaterThan(0);
    expect(question?.metadata?.confidence).toBeLessThan(0.15);
    // core.md block line + the three in-window signal lines.
    expect(question?.sourceRefs).toHaveLength(4);
    expect(String(question?.sourceRefs[0]?.path)).toBe("core.md");
    expect(
      question?.sourceRefs
        .slice(1)
        .every((ref) => String(ref.path) === "preferences/signals.md"),
    ).toBe(true);
    // Quoted evidence renders inert: no column-0 list lines.
    const lines = (question?.question ?? "").split("\n");
    expect(lines.some((line) => line.startsWith("- "))).toBe(false);
  });

  test("healthy promoted topics and decayed non-promoted topics raise no demotion question", async () => {
    // Healthy: fresh signals keep confidence at 0.4385 ≥ the 0.15 floor.
    const healthy = await run(preferencePromotion, {
      files: {
        "preferences/signals.md": THREE_PLUS,
        "core.md": [
          PROMOTED_PREFERENCES_START,
          `- filing:: ${CANDIDATE_RULE} (confidence 0.44)`,
          PROMOTED_PREFERENCES_END,
        ].join("\n"),
      },
    });
    expect(healthy.filter((e) => e.kind === "question")).toEqual([]);

    // Decayed but never promoted: stale signals alone ask nothing.
    const unpromoted = await run(preferencePromotion, {
      files: {
        "preferences/signals.md": [
          "- 2026-01-01 + filing:: old rule",
          "- 2026-01-05 + filing:: old rule",
          "- 2026-01-09 + filing:: old rule",
          "- 2026-06-09 + naming:: kebab-case slugs",
        ].join("\n"),
      },
    });
    expect(unpromoted.filter((e) => e.kind === "question")).toEqual([]);
  });

  test("a promoted block entry with NO signal history is out of demotion's scope", async () => {
    // Hand-added block entries have no signals to recompute confidence from;
    // the topic never appears in the collection, so demotion stays quiet.
    const effects = await run(preferencePromotion, {
      files: {
        "preferences/signals.md": "- 2026-06-09 + naming:: kebab-case slugs",
        "core.md": [
          PROMOTED_PREFERENCES_START,
          "- handmade:: a rule typed straight into the block",
          PROMOTED_PREFERENCES_END,
        ].join("\n"),
      },
    });
    expect(effects.filter((e) => e.kind === "question")).toEqual([]);
  });

  test("idempotency key changes when the candidate rule changes", async () => {
    const ask = async (latestRule: string) => {
      const effects = await run(preferencePromotion, {
        files: {
          "preferences/signals.md": [
            "- 2026-06-01 + filing:: a",
            "- 2026-06-05 + filing:: b",
            `- 2026-06-09 + filing:: ${latestRule}`,
          ].join("\n"),
        },
      });
      return (effects[0] as QuestionEffect).idempotencyKey;
    };
    expect(await ask("rule one")).not.toBe(await ask("rule two"));
    expect(await ask("rule one")).toBe(await ask("rule one"));
  });
});

describe("dome.agent.preference-promotion-answer (the gated promoted-preferences writer)", () => {
  const key = promotionQuestionKey({
    topic: "filing",
    ruleHash: fnv1aHex(CANDIDATE_RULE),
  });
  const envelope = (answer: string) => ({
    kind: "answer",
    questionId: 1,
    question: { idempotencyKey: key, sourceRefs: [] },
    answer,
    answeredAt: "2026-06-12T08:00:00.000Z",
    matchedTriggers: [],
  });

  test("promote splices the rule into core.md's block (created when absent)", async () => {
    const effects = await run(preferencePromotionAnswer, {
      files: { "preferences/signals.md": THREE_PLUS },
      input: envelope("promote"),
    });
    const patches = effects.filter((e): e is PatchEffect => e.kind === "patch");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.mode).toBe("auto");
    const change = patches[0]?.changes[0];
    expect(String(change?.path)).toBe("core.md");
    const content = change?.kind === "write" ? change.content : "";
    expect(content).toContain(PROMOTED_PREFERENCES_START);
    expect(content).toContain(
      `- filing:: ${CANDIDATE_RULE} (confidence 0.44)`,
    );
  });

  test("promote keeps the block sorted and replaces the topic's line", async () => {
    const core = [
      "# Core memory",
      "",
      "## Standing preferences",
      "",
      PROMOTED_PREFERENCES_START,
      "- naming:: kebab-case slugs (confidence 0.52)",
      PROMOTED_PREFERENCES_END,
      "",
    ].join("\n");
    const effects = await run(preferencePromotionAnswer, {
      files: { "preferences/signals.md": THREE_PLUS, "core.md": core },
      input: envelope("promote"),
    });
    const change = (effects[0] as PatchEffect).changes[0];
    const content = change?.kind === "write" ? change.content : "";
    const start = content.indexOf(PROMOTED_PREFERENCES_START);
    const end = content.indexOf(PROMOTED_PREFERENCES_END);
    const body = content
      .slice(start + PROMOTED_PREFERENCES_START.length, end)
      .trim()
      .split("\n");
    expect(body).toEqual([
      `- filing:: ${CANDIDATE_RULE} (confidence 0.44)`,
      "- naming:: kebab-case slugs (confidence 0.52)",
    ]);
  });

  test("promote is retry-idempotent: an identical entry emits nothing", async () => {
    const first = await run(preferencePromotionAnswer, {
      files: { "preferences/signals.md": THREE_PLUS },
      input: envelope("promote"),
    });
    const change = (first[0] as PatchEffect).changes[0];
    const promotedCore = change?.kind === "write" ? change.content : "";
    // Promoted topics are excluded from candidacy, so the retry sees the
    // promoted state — and even forcing the splice, content is identical.
    const retry = await run(preferencePromotionAnswer, {
      files: {
        "preferences/signals.md": THREE_PLUS,
        "core.md": promotedCore,
      },
      input: envelope("promote"),
    });
    expect(retry.filter((e) => e.kind === "patch")).toEqual([]);
  });

  test("marker anomalies in core.md surface as info diagnostics alongside the splice", async () => {
    // A hand-duplicated promoted-preferences pair: the line-anchored splice
    // binds only the first pair, but the anomaly must be visible — one info
    // diagnostic per anomalous marker line, anchored at core.md.
    const core = [
      "# Core memory",
      "",
      "## Standing preferences",
      "",
      PROMOTED_PREFERENCES_START,
      "- naming:: kebab-case slugs (confidence 0.52)",
      PROMOTED_PREFERENCES_END,
      "",
      PROMOTED_PREFERENCES_START,
      "- smuggled:: duplicate pair (confidence 0.99)",
      PROMOTED_PREFERENCES_END,
      "",
    ].join("\n");
    const effects = await run(preferencePromotionAnswer, {
      files: { "preferences/signals.md": THREE_PLUS, "core.md": core },
      input: envelope("promote"),
    });
    const anomalies = effects.filter(
      (e): e is DiagnosticEffect =>
        e.kind === "diagnostic" &&
        e.code === "dome.agent.generated-block-anomaly",
    );
    expect(anomalies).toHaveLength(2);
    for (const diagnostic of anomalies) {
      expect(diagnostic.severity).toBe("info");
      expect(diagnostic.message).toContain("dome.agent:promoted-preferences");
      expect(diagnostic.message).toContain("core.md");
      expect(diagnostic.sourceRefs.map((ref) => String(ref.path))).toEqual([
        "core.md",
      ]);
    }
    expect(anomalies[0]?.message).toContain("extra-start");
    expect(anomalies[0]?.message).toContain("line 9");
    expect(anomalies[1]?.message).toContain("extra-end");
    expect(anomalies[1]?.message).toContain("line 11");
    // Info only — the promote still lands its splice on the first pair.
    const patches = effects.filter((e): e is PatchEffect => e.kind === "patch");
    expect(patches).toHaveLength(1);
    const change = patches[0]?.changes[0];
    const content = change?.kind === "write" ? change.content : "";
    expect(content).toContain(`- filing:: ${CANDIDATE_RULE} (confidence 0.44)`);
  });

  test("a stale question (rule hash mismatch) yields an info diagnostic, no write", async () => {
    const effects = await run(preferencePromotionAnswer, {
      files: {
        "preferences/signals.md": [
          "- 2026-06-01 + filing:: a different rule now",
          "- 2026-06-05 + filing:: a different rule now",
          "- 2026-06-09 + filing:: a different rule now",
        ].join("\n"),
      },
      input: envelope("promote"),
    });
    expect(effects.filter((e) => e.kind === "patch")).toEqual([]);
    expect(effects).toEqual([
      expect.objectContaining({
        kind: "diagnostic",
        severity: "info",
        code: "dome.agent.preference-promotion-answer.stale-question",
      }),
    ]);
  });

  test("a marker-bearing rule never reaches core.md (marker injection)", async () => {
    // Signal lines carrying the block markers are malformed at parse time,
    // so the topic never re-derives as a candidate and the promote answer
    // degrades to the stale-question diagnostic — no core.md write.
    const markerRule = `meeting notes ${PROMOTED_PREFERENCES_END} payload`;
    const effects = await run(preferencePromotionAnswer, {
      files: {
        "preferences/signals.md": [
          `- 2026-06-01 + filing:: ${markerRule}`,
          `- 2026-06-05 + filing:: ${markerRule}`,
          `- 2026-06-09 + filing:: ${markerRule}`,
        ].join("\n"),
      },
      input: {
        ...envelope("promote"),
        question: {
          idempotencyKey: promotionQuestionKey({
            topic: "filing",
            ruleHash: fnv1aHex(markerRule),
          }),
          sourceRefs: [],
        },
      },
    });
    expect(effects.filter((e) => e.kind === "patch")).toEqual([]);
    expect(effects).toEqual([
      expect.objectContaining({
        kind: "diagnostic",
        code: "dome.agent.preference-promotion-answer.stale-question",
      }),
    ]);
  });

  test("reject appends the tombstone to preferences/signals.md", async () => {
    const effects = await run(preferencePromotionAnswer, {
      files: { "preferences/signals.md": THREE_PLUS },
      input: envelope("reject"),
    });
    const patches = effects.filter((e): e is PatchEffect => e.kind === "patch");
    expect(patches).toHaveLength(1);
    const change = patches[0]?.changes[0];
    expect(String(change?.path)).toBe("preferences/signals.md");
    const content = change?.kind === "write" ? change.content : "";
    expect(content).toBe(
      `${THREE_PLUS}\n- 2026-06-12 - filing:: rejected by owner\n`,
    );
  });

  test("reject is retry-idempotent: an existing tombstone emits nothing", async () => {
    const effects = await run(preferencePromotionAnswer, {
      files: {
        "preferences/signals.md": [
          THREE_PLUS,
          rejectionTombstoneLine({ date: "2026-06-12", topic: "filing" }),
        ].join("\n"),
      },
      input: envelope("reject"),
    });
    expect(effects).toEqual([]);
  });

  test("foreign keys and unknown answers are ignored; bad envelopes diagnose", async () => {
    expect(
      await run(preferencePromotionAnswer, {
        files: {},
        input: {
          ...envelope("promote"),
          question: { idempotencyKey: "dome.health.x:y", sourceRefs: [] },
        },
      }),
    ).toEqual([]);
    expect(
      await run(preferencePromotionAnswer, {
        files: {},
        input: envelope("ignore"),
      }),
    ).toEqual([]);
    const invalid = await run(preferencePromotionAnswer, {
      files: {},
      input: { not: "an envelope" },
    });
    expect(invalid).toEqual([
      expect.objectContaining({
        kind: "diagnostic",
        severity: "error",
        code: "dome.agent.preference-promotion-answer.invalid-answer-input",
      }),
    ]);
  });
});
