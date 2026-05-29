// dome.daily.ambiguous-followup-answer — tracks accepted prose follow-ups.

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

import {
  insertTrackedFollowup,
  parseAmbiguousFollowupAnswer,
  targetFromAmbiguousFollowupQuestionKey,
} from "./ambiguous-followup-shared";

const ambiguousFollowupAnswer = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseAnswerInput(ctx.input);
    if (input === null) {
      return [
        diagnosticEffect({
          severity: "error",
          code: "dome.daily.ambiguous-followup-answer.invalid-answer-input",
          message:
            "Daily ambiguous follow-up answer handler received an invalid answer envelope.",
          sourceRefs: [],
        }),
      ];
    }

    const answer = parseAmbiguousFollowupAnswer(input.answer);
    const target = targetFromAmbiguousFollowupQuestionKey(
      input.question.idempotencyKey,
    );
    if (target === null || answer === null || answer === "ignore") {
      return Object.freeze([]);
    }

    const content = await ctx.snapshot.readFile(target.path);
    if (content === null) {
      return [
        diagnosticEffect({
          severity: "error",
          code: "dome.daily.ambiguous-followup-answer.missing-source-page",
          message:
            `Cannot track ambiguous follow-up from ${target.path}: ` +
            "the source page was not found.",
          sourceRefs: input.question.sourceRefs,
        }),
      ];
    }

    const next = insertTrackedFollowup({
      content,
      text: target.text,
    });
    if (next === content) return Object.freeze([]);

    return [
      patchEffect({
        mode: "auto",
        changes: [
          {
            kind: "write",
            path: target.path,
            content: next,
          },
        ],
        reason:
          `dome.daily: track answered ambiguous follow-up from ${target.path}`,
        sourceRefs: input.question.sourceRefs,
      }),
    ];
  },
});

export default ambiguousFollowupAnswer;

type AnswerInput = {
  readonly question: {
    readonly idempotencyKey: string;
    readonly sourceRefs: QuestionEffect["sourceRefs"];
  };
  readonly answer: string;
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
  return Object.freeze({
    question: Object.freeze({
      idempotencyKey: questionRecord.idempotencyKey,
      sourceRefs:
        questionRecord.sourceRefs as AnswerInput["question"]["sourceRefs"],
    }),
    answer: record.answer,
  });
}
