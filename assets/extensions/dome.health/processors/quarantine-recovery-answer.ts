// dome.health.quarantine-recovery-answer — applies quarantine reset answers.
//
// The processor emits QuarantineRecoveryEffect rather than touching the
// processor execution-state store. The engine-owned sink performs the reset
// after capability enforcement and ledgering.

import {
  quarantineRecoveryEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  parseQuarantineRecoveryAnswer,
  targetFromQuestionIdempotencyKey,
} from "./quarantine-recovery-shared";
import {
  invalidRecoveryAnswerInputDiagnostic,
  parseRecoveryAnswerInput,
} from "./recovery-answer-input";

const quarantineRecoveryAnswer = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseRecoveryAnswerInput(ctx.input);
    if (input === null) {
      return [
        invalidRecoveryAnswerInputDiagnostic({
          code: "dome.health.quarantine-recovery.invalid-answer-input",
          message:
            "Quarantine recovery answer handler received an invalid answer envelope.",
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
        quarantineId: target.quarantineId,
        quarantinedAt: target.quarantinedAt,
        consecutiveRetryableFailures:
          target.consecutiveRetryableFailures,
        reason: "dome.health: reset quarantined processor trigger",
        sourceRefs: input.question.sourceRefs,
      }),
    ];
  },
});

export default quarantineRecoveryAnswer;
