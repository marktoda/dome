// dome.agent.preference-promotion — owner-needed promotion questions
// (memory-quality M5, docs/wiki/specs/preferences.md).
//
// For every topic in the `candidate` state — ≥ 3 same-sign signals in the
// 30-day window, not already promoted (core.md's block is checked), not
// rebutted, not owner-rejected — emits one QuestionEffect proposing the
// candidate rule VERBATIM with the in-window evidence lines quoted.
//
// Idempotency: the key is `dome.agent.preference-promotion:<topic>:<rule-hash>`
// — one open question per topic + rule (re-emission refreshes the open row;
// an answered row stays answered, so there is no re-ask), and a changed
// candidate rule asks fresh. Promotions change agent behavior, so the
// metadata is `automationPolicy: "owner-needed"`: never auto-resolved — the
// owner decides. Confidence is the Wilson 95% lower bound × 90-day
// freshness from the shared library.
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
  PREFERENCE_PROMOTION_THRESHOLD,
  PREFERENCE_SIGNALS_PATH,
  PREFERENCE_WINDOW_DAYS,
  promotionQuestionKey,
  type PreferenceTopic,
} from "../lib/preferences-shared";

const preferencePromotion = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const signalsContent = await ctx.snapshot.readFile(
      PREFERENCE_SIGNALS_PATH,
    );
    if (signalsContent === null) return Object.freeze([]);
    const coreContent = await ctx.snapshot.readFile(
      coreMemoryPath(ctx.extensionConfig).path,
    );
    const collection = collectPreferenceTopics({ signalsContent, coreContent });

    const effects: Effect[] = [];
    for (const topic of collection.topics) {
      if (topic.state !== "candidate") continue;
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
