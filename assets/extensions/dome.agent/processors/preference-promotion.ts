// dome.agent.preference-promotion — owner-needed promotion AND demotion
// questions (memory-quality M5 + WS1 pruning, docs/wiki/specs/preferences.md).
//
// Promotion: for every topic in the `candidate` state — ≥ 3 same-sign signals
// in the 30-day window, not already promoted (core.md's block is checked),
// not rebutted, not owner-rejected — emits one QuestionEffect proposing the
// candidate rule VERBATIM with the in-window evidence lines quoted.
//
// Demotion (the lifecycle's closing tail): for every `promoted` topic whose
// recomputed confidence — the same Wilson × freshness formula that promoted
// it — has decayed below DEMOTE_BELOW_CONFIDENCE, emits one QuestionEffect
// proposing removal. Freshness alone gets there: no signals for 90 days →
// freshness 0 → confidence 0. The key hashes the PROMOTED BLOCK's rule text
// (what `demote` would splice out), not the latest signal's.
//
// Idempotency: promotion keys are
// `dome.agent.preference-promotion:<topic>:<rule-hash>`, demotion keys are
// `dome.agent.preference-demotion:<topic>:<rule-hash>` — one open question
// per topic + rule (re-emission refreshes the open row; an answered row
// stays answered, so there is no re-ask), and a changed rule asks fresh.
// Both change agent behavior on every future run, so the metadata is
// `automationPolicy: "owner-needed"`: never auto-resolved — the owner
// decides. Confidence is the Wilson 95% lower bound × 90-day freshness from
// the shared library.
//
// Deterministic (no model, no clock): same snapshot → same questions.

import { questionEffect, type Effect } from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import { coreMemoryPath } from "../lib/core-memory";
import {
  collectPreferenceTopics,
  DEMOTE_BELOW_CONFIDENCE,
  demotionQuestionKey,
  fnv1aHex,
  PREFERENCE_PROMOTION_THRESHOLD,
  PREFERENCE_SIGNALS_PATH,
  PREFERENCE_WINDOW_DAYS,
  promotedPreferenceEntries,
  promotionQuestionKey,
  type PreferenceTopic,
  type PromotedPreferenceEntry,
} from "../lib/preferences-shared";

const preferencePromotion = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const signalsContent = await ctx.snapshot.readFile(
      PREFERENCE_SIGNALS_PATH,
    );
    if (signalsContent === null) return Object.freeze([]);
    const corePath = coreMemoryPath(ctx.extensionConfig).path;
    const coreContent = await ctx.snapshot.readFile(corePath);
    const collection = collectPreferenceTopics({ signalsContent, coreContent });
    const promotedEntries = promotedPreferenceEntries(coreContent);

    const effects: Effect[] = [];
    for (const topic of collection.topics) {
      if (topic.state === "candidate") {
        if (topic.rule === null || topic.ruleHash === null) continue;
        effects.push(
          questionEffect({
            question: promotionQuestion(topic),
            options: ["promote", "reject"],
            idempotencyKey: promotionQuestionKey({
              topic: topic.topic,
              ruleHash: topic.ruleHash,
            }),
            sourceRefs: topic.evidence.map((signal) =>
              ctx.sourceRef(PREFERENCE_SIGNALS_PATH, {
                startLine: signal.line,
                endLine: signal.line,
              }),
            ),
            metadata: {
              automationPolicy: "owner-needed",
              confidence: topic.confidence,
              recommendedAnswer: "promote",
              ownerNeededReason:
                "Promoting a standing preference changes agent behavior on every future run; the owner decides.",
            },
          }),
        );
        continue;
      }

      // Demotion candidates: promoted AND decayed below the floor. Topics
      // with a block entry but NO signal history never appear in the
      // collection — hand-added entries are out of demotion's scope.
      if (topic.state !== "promoted") continue;
      if (topic.confidence >= DEMOTE_BELOW_CONFIDENCE) continue;
      const entry = promotedEntries.find((e) => e.topic === topic.topic);
      if (entry === undefined) continue;
      effects.push(
        questionEffect({
          question: demotionQuestion(topic, entry),
          options: ["demote", "keep"],
          idempotencyKey: demotionQuestionKey({
            topic: topic.topic,
            ruleHash: fnv1aHex(entry.rule),
          }),
          sourceRefs: [
            // The promoted block's core.md line, then the in-window signal
            // lines (often none — staleness is the usual decay path).
            ctx.sourceRef(corePath, {
              startLine: entry.line,
              endLine: entry.line,
            }),
            ...topic.evidence.map((signal) =>
              ctx.sourceRef(PREFERENCE_SIGNALS_PATH, {
                startLine: signal.line,
                endLine: signal.line,
              }),
            ),
          ],
          metadata: {
            automationPolicy: "owner-needed",
            confidence: topic.confidence,
            recommendedAnswer: "demote",
            ownerNeededReason:
              "Demoting a standing preference changes agent behavior on every future run; the owner decides.",
          },
        }),
      );
    }
    return Object.freeze(effects);
  },
});

export default preferencePromotion;

function promotionQuestion(topic: PreferenceTopic): string {
  return [
    `Promote a standing preference for topic "${topic.topic}"?`,
    "",
    `Proposed rule (verbatim from the latest correction): ${topic.rule}`,
    "",
    `Evidence: ${PREFERENCE_PROMOTION_THRESHOLD}+ supporting corrections within ${PREFERENCE_WINDOW_DAYS} days (${topic.plusInWindow} for, ${topic.minusInWindow} against):`,
    ...topic.evidence.map((signal) => `  ${signal.raw}`),
    "",
    "`promote` adds the rule to core.md's promoted-preferences block (it then rides every agent run); `reject` retires the topic so it is not proposed again.",
  ].join("\n");
}

function demotionQuestion(
  topic: PreferenceTopic,
  entry: PromotedPreferenceEntry,
): string {
  const evidence =
    topic.evidence.length === 0
      ? [
          `No signals within the ${PREFERENCE_WINDOW_DAYS}-day window — the rule has gone stale.`,
        ]
      : [
          `Recent signals within ${PREFERENCE_WINDOW_DAYS} days (${topic.plusInWindow} for, ${topic.minusInWindow} against):`,
          ...topic.evidence.map((signal) => `  ${signal.raw}`),
        ];
  return [
    `Demote the standing preference for topic "${topic.topic}"?`,
    "",
    `Promoted rule: ${entry.rule}`,
    "",
    `Its confidence has decayed to ${topic.confidence} — below the ${DEMOTE_BELOW_CONFIDENCE} demotion floor (same Wilson × freshness formula that promoted it).`,
    ...evidence,
    "",
    "`demote` removes the rule from core.md's promoted-preferences block and records a minus signal (NOT a rejection — the topic can re-earn promotion if corrections re-accrue); `keep` reaffirms the rule with a fresh plus signal, resetting its confidence.",
  ].join("\n");
}
