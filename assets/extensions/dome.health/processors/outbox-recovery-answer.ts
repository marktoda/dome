// dome.health.outbox-recovery-answer — applies retry/abandon answers.
//
// The processor emits OutboxRecoveryEffect rather than touching outbox.db.
// The engine-owned sink performs the state transition after capability
// enforcement and ledgering.

import {
  diagnosticEffect,
  outboxRecoveryEffect,
  type Effect,
  type QuestionEffect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  OUTBOX_RECOVERY_QUESTION_PREFIX,
  outboxKeyFromQuestionIdempotencyKey,
  parseOutboxRecoveryAnswer,
} from "./outbox-recovery-shared";

const outboxRecoveryAnswer: Processor = defineProcessor({
  id: "dome.health.outbox-recovery-answer",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    {
      kind: "answer",
      idempotencyKeyPrefix: OUTBOX_RECOVERY_QUESTION_PREFIX,
    },
  ],
  capabilities: [{ kind: "outbox.recover", actions: ["retry", "abandon"] }],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseAnswerInput(ctx.input);
    if (input === null) {
      return [
        diagnosticEffect({
          severity: "error",
          code: "dome.health.outbox-recovery.invalid-answer-input",
          message:
            "Outbox recovery answer handler received an invalid answer envelope.",
          sourceRefs: [],
        }),
      ];
    }

    const outboxKey = outboxKeyFromQuestionIdempotencyKey(
      input.question.idempotencyKey,
    );
    const action = parseOutboxRecoveryAnswer(input.answer);
    if (outboxKey === null || action === null) return Object.freeze([]);

    return [
      outboxRecoveryEffect({
        idempotencyKey: outboxKey,
        action,
        reason: `dome.health: ${action} failed outbox row`,
        sourceRefs: input.question.sourceRefs,
      }),
    ];
  },
});

export default outboxRecoveryAnswer;

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
