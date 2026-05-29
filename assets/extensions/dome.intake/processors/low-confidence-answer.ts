// dome.intake.low-confidence-answer — applies accepted capture questions.

import {
  diagnosticEffect,
  patchEffect,
  type Effect,
  type QuestionEffect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  captureOutputPaths,
  insertTrackedCaptureItem,
} from "./capture-page";
import {
  LOW_CONFIDENCE_QUESTION_PREFIX,
  parseLowConfidenceAnswer,
  targetFromLowConfidenceQuestionKey,
} from "./low-confidence-shared";

const lowConfidenceAnswer: Processor = defineProcessor({
  id: "dome.intake.low-confidence-answer",
  version: "0.2.0",
  phase: "garden",
  triggers: [
    {
      kind: "answer",
      questionProcessorId: "dome.intake.extract-capture",
      idempotencyKeyPrefix: LOW_CONFIDENCE_QUESTION_PREFIX,
    },
  ],
  capabilities: [
    { kind: "read", paths: ["inbox/raw/*.md", "wiki/generated/intake/*.md"] },
    { kind: "patch.auto", paths: ["wiki/generated/intake/*.md"] },
  ],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseAnswerInput(ctx.input);
    if (input === null) {
      return [
        diagnosticEffect({
          severity: "error",
          code: "dome.intake.low-confidence-answer.invalid-answer-input",
          message:
            "Intake low-confidence answer handler received an invalid answer envelope.",
          sourceRefs: [],
        }),
      ];
    }

    const answer = parseLowConfidenceAnswer(input.answer);
    const target = targetFromLowConfidenceQuestionKey(
      input.question.idempotencyKey,
    );
    if (target === null || answer === null || answer === "ignore") {
      return Object.freeze([]);
    }

    const paths = captureOutputPaths(target.path);
    const content = await ctx.snapshot.readFile(paths.generated);
    if (content === null) {
      return [
        diagnosticEffect({
          severity: "error",
          code: "dome.intake.low-confidence-answer.missing-capture-page",
          message:
            `Cannot track low-confidence ${target.kind} from ${target.path}: ` +
            `generated capture page ${paths.generated} was not found.`,
          sourceRefs: input.question.sourceRefs,
        }),
      ];
    }

    const next = insertTrackedCaptureItem({
      content,
      kind: target.kind,
      text: target.text,
      confidence: target.confidence ?? 1,
    });
    if (next === content) return Object.freeze([]);

    return [
      patchEffect({
        mode: "auto",
        changes: [
          {
            kind: "write",
            path: paths.generated,
            content: next,
          },
        ],
        reason:
          `dome.intake: track answered low-confidence ${target.kind} from ` +
          target.path,
        sourceRefs: input.question.sourceRefs,
      }),
    ];
  },
});

export default lowConfidenceAnswer;

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
