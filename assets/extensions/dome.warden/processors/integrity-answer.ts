// dome.warden.integrity-answer — routes resolutions of integrity-warden
// questions so the question lifecycle closes.
//
// Triggered by `kind: answer` on dome.warden.integrity questions. The durable
// answer already persists in answers.db and rehydrates on rebuild; this
// handler exists so resolutions are routed and the open question settles. It
// is a NORMAL (no-model) garden processor — it holds only `read`. For v1 it
// emits an info diagnostic acknowledging the resolution, and emits nothing on
// a malformed answer envelope. It never emits a FactEffect or a PatchEffect:
// wardens are questions-only and the resolution itself is the durable record.

import {
  diagnosticEffect,
  type Effect,
  type QuestionEffect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

type AnswerInput = {
  readonly question: {
    readonly idempotencyKey: string;
    readonly sourceRefs: QuestionEffect["sourceRefs"];
  };
  readonly answer: string;
};

const integrityAnswer = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseAnswerInput(ctx.input);
    if (input === null) return Object.freeze([]);

    return [
      diagnosticEffect({
        severity: "info",
        code: "dome.warden.integrity.resolved",
        message:
          `Integrity flag ${input.question.idempotencyKey} resolved: ` +
          input.answer,
        sourceRefs: input.question.sourceRefs,
      }),
    ];
  },
});

export default integrityAnswer;

function parseAnswerInput(input: unknown): AnswerInput | null {
  if (input === null || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const question = record.question;
  if (question === null || typeof question !== "object") return null;
  const questionRecord = question as Record<string, unknown>;
  if (typeof questionRecord.idempotencyKey !== "string") return null;
  if (!Array.isArray(questionRecord.sourceRefs)) return null;
  if (typeof record.answer !== "string") return null;
  return Object.freeze({
    question: Object.freeze({
      idempotencyKey: questionRecord.idempotencyKey,
      sourceRefs:
        questionRecord.sourceRefs as AnswerInput["question"]["sourceRefs"],
    }),
    answer: record.answer,
  });
}
