// dome.health.quarantine-recovery-answer — applies quarantine reset answers.
//
// The processor emits QuarantineRecoveryEffect rather than touching the
// processor execution-state store. The engine-owned sink performs the reset
// after capability enforcement and ledgering.

import {
  diagnosticEffect,
  quarantineRecoveryEffect,
  type Effect,
  type QuestionEffect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  QUARANTINE_RECOVERY_QUESTION_PREFIX,
  parseQuarantineRecoveryAnswer,
  targetFromQuestionIdempotencyKey,
} from "./quarantine-recovery-shared";

const quarantineRecoveryAnswer: Processor = defineProcessor({
  id: "dome.health.quarantine-recovery-answer",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    {
      kind: "answer",
      idempotencyKeyPrefix: QUARANTINE_RECOVERY_QUESTION_PREFIX,
    },
  ],
  capabilities: [{ kind: "quarantine.recover", actions: ["reset"] }],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseAnswerInput(ctx.input);
    if (input === null) {
      return [
        diagnosticEffect({
          severity: "error",
          code: "dome.health.quarantine-recovery.invalid-answer-input",
          message:
            "Quarantine recovery answer handler received an invalid answer envelope.",
          sourceRefs: [],
        }),
      ];
    }

    const target = targetFromQuestionIdempotencyKey(
      input.question.idempotencyKey,
    );
    const action = parseQuarantineRecoveryAnswer(input.answer);
    if (target === null || action === null || action === "ignore") {
      return Object.freeze([]);
    }

    return [
      quarantineRecoveryEffect({
        action,
        phase: target.phase,
        processorId: target.processorId,
        processorVersion: target.processorVersion,
        triggerHash: target.triggerHash,
        reason: "dome.health: reset quarantined processor trigger",
        sourceRefs: input.question.sourceRefs,
      }),
    ];
  },
});

export default quarantineRecoveryAnswer;

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
      sourceRefs: questionRecord.sourceRefs as AnswerInput["question"]["sourceRefs"],
    }),
    answer: record.answer,
  });
}
