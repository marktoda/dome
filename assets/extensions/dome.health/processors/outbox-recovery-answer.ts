// dome.health.outbox-recovery-answer — applies retry/abandon answers.
//
// The processor emits OutboxRecoveryEffect rather than touching outbox.db.
// The engine-owned sink performs the state transition after capability
// enforcement and ledgering.

import {
  outboxRecoveryEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  failureTokenFromQuestionIdempotencyKey,
  OUTBOX_RECOVERY_QUESTION_PREFIX,
  outboxKeyFromQuestionIdempotencyKey,
  parseOutboxRecoveryAnswer,
} from "./outbox-recovery-shared";
import {
  invalidRecoveryAnswerInputDiagnostic,
  parseRecoveryAnswerInput,
} from "./recovery-answer-input";

const outboxRecoveryAnswer = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseRecoveryAnswerInput(ctx.input);
    if (input === null) {
      return [
        invalidRecoveryAnswerInputDiagnostic({
          code: "dome.health.outbox-recovery.invalid-answer-input",
          message:
            "Outbox recovery answer handler received an invalid answer envelope.",
        }),
      ];
    }

    const outboxKey = outboxKeyFromQuestionIdempotencyKey(
      input.question.idempotencyKey,
    );
    const failureToken = failureTokenFromQuestionIdempotencyKey(
      input.question.idempotencyKey,
    );
    const action = parseOutboxRecoveryAnswer(input.answer);
    if (outboxKey === null || action === null) return Object.freeze([]);

    return [
      outboxRecoveryEffect({
        idempotencyKey: outboxKey,
        ...(failureToken !== null ? { failureToken } : {}),
        action,
        reason: `dome.health: ${action} failed outbox row`,
        sourceRefs: input.question.sourceRefs,
      }),
    ];
  },
});

export default outboxRecoveryAnswer;
