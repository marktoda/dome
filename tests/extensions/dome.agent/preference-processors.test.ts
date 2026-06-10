// Unit coverage for the three M5 preference processors
// (docs/wiki/specs/preferences.md): the deterministic counter
// (dome.agent.preference-signals), the promotion question emitter
// (dome.agent.preference-promotion), and the answer handler
// (dome.agent.preference-promotion-answer — core.md's single auto-writer).

import { describe, expect, test } from "bun:test";

import preferencePromotion from "../../../assets/extensions/dome.agent/processors/preference-promotion";
import preferencePromotionAnswer from "../../../assets/extensions/dome.agent/processors/preference-promotion-answer";
import preferenceSignals from "../../../assets/extensions/dome.agent/processors/preference-signals";
import {
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

describe("dome.agent.preference-promotion-answer (the single auto-writer)", () => {
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
