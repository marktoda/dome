// dome.agent.preference-promotion-answer — the single auto-writer to core.md
// (memory-quality M5, docs/wiki/specs/preferences.md §"The single-auto-writer
// exception"; memory decision 4: the question WAS the review).
//
// On `promote`: re-derives the topic's candidate state from the CURRENT
// snapshot, verifies the rule hash in the question's idempotency key still
// matches (a stale question — signals moved on — yields an info diagnostic
// and no write), and emits one PatchEffect (mode auto) splicing the rule
// into core.md's marker-delimited promoted-preferences block (sorted, one
// line per topic, confidence recomputed at answer time).
//
// On `reject`: appends the rejection tombstone
// (`- YYYY-MM-DD - <topic>:: rejected by owner`) to preferences/signals.md;
// the counter parses it as a permanent owner rejection, so the topic is
// never re-proposed.
//
// Grant shape: this processor's manifest declares read + patch.auto over
// exactly core.md + preferences/signals.md, and the vault config gives it a
// matching narrow per-processor replacement grant — the broker resolves
// grants per processor, so no other processor can auto-write core.md.
// Idempotent under answer-handler retries: a splice/tombstone that is
// already present emits no effect.

import {
  diagnosticEffect,
  patchEffect,
  type Effect,
  type QuestionEffect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import { coreMemoryPath } from "../lib/core-memory";
import {
  appendSignalLine,
  collectPreferenceTopics,
  PREFERENCE_SIGNALS_PATH,
  promotionTargetFromKey,
  rejectionTombstoneLine,
  splicePromotedPreference,
} from "../lib/preferences-shared";

const preferencePromotionAnswer = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseAnswerInput(ctx.input);
    if (input === null) {
      return [
        diagnosticEffect({
          severity: "error",
          code: "dome.agent.preference-promotion-answer.invalid-answer-input",
          message:
            "Preference promotion answer handler received an invalid answer envelope.",
          sourceRefs: [],
        }),
      ];
    }

    const target = promotionTargetFromKey(input.question.idempotencyKey);
    const answer = input.answer.trim().toLowerCase();
    if (target === null || (answer !== "promote" && answer !== "reject")) {
      return Object.freeze([]);
    }

    const corePath = coreMemoryPath(ctx.extensionConfig).path;
    const signalsContent = await ctx.snapshot.readFile(
      PREFERENCE_SIGNALS_PATH,
    );
    const coreContent = await ctx.snapshot.readFile(corePath);

    if (answer === "reject") {
      const tombstone = rejectionTombstoneLine({
        date: input.answeredAt.slice(0, 10),
        topic: target.topic,
      });
      // Retry-idempotent: an already-recorded rejection is a no-op.
      if (
        signalsContent !== null &&
        signalsContent
          .split("\n")
          .some((line) => line.trim() === tombstone)
      ) {
        return Object.freeze([]);
      }
      return [
        patchEffect({
          mode: "auto",
          changes: [
            {
              kind: "write",
              path: PREFERENCE_SIGNALS_PATH,
              content: appendSignalLine(signalsContent, tombstone),
            },
          ],
          reason: `dome.agent: owner rejected preference promotion for topic "${target.topic}"`,
          sourceRefs: input.question.sourceRefs,
        }),
      ];
    }

    // promote — re-derive the candidate from the current snapshot and verify
    // the question still describes it.
    const collection = collectPreferenceTopics({ signalsContent, coreContent });
    const topic = collection.topics.find((t) => t.topic === target.topic);
    if (
      topic === undefined ||
      topic.rule === null ||
      topic.ruleHash !== target.ruleHash
    ) {
      return [
        diagnosticEffect({
          severity: "info",
          code: "dome.agent.preference-promotion-answer.stale-question",
          message:
            `Promotion answer for topic "${target.topic}" no longer matches the signals page ` +
            "(the candidate rule changed or its signals are gone); nothing was promoted. " +
            "A current candidate will raise a fresh question.",
          sourceRefs: input.question.sourceRefs,
        }),
      ];
    }
    if (topic.state === "rejected") {
      // An owner rejection recorded after the question was asked wins.
      return Object.freeze([]);
    }

    const next = splicePromotedPreference({
      coreContent,
      topic: topic.topic,
      rule: topic.rule,
      confidence: topic.confidence,
    });
    // Retry-idempotent: re-promoting an identical entry is a no-op.
    if (coreContent !== null && next === coreContent) {
      return Object.freeze([]);
    }
    return [
      patchEffect({
        mode: "auto",
        changes: [{ kind: "write", path: corePath, content: next }],
        reason: `dome.agent: promote owner preference "${topic.topic}" into ${corePath}`,
        sourceRefs: input.question.sourceRefs,
      }),
    ];
  },
});

export default preferencePromotionAnswer;

type AnswerInput = {
  readonly question: {
    readonly idempotencyKey: string;
    readonly sourceRefs: QuestionEffect["sourceRefs"];
  };
  readonly answer: string;
  readonly answeredAt: string;
};

function parseAnswerInput(input: unknown): AnswerInput | null {
  if (input === null || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const question = record.question;
  if (question === null || typeof question !== "object") return null;
  const questionRecord = question as Record<string, unknown>;
  if (typeof questionRecord.idempotencyKey !== "string") return null;
  if (!Array.isArray(questionRecord.sourceRefs)) return null;
  if (typeof record.answer !== "string") return null;
  if (typeof record.answeredAt !== "string") return null;
  if (Number.isNaN(Date.parse(record.answeredAt))) return null;
  return Object.freeze({
    question: Object.freeze({
      idempotencyKey: questionRecord.idempotencyKey,
      sourceRefs:
        questionRecord.sourceRefs as AnswerInput["question"]["sourceRefs"],
    }),
    answer: record.answer,
    answeredAt: record.answeredAt,
  });
}
