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
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  QUARANTINE_RECOVERY_QUESTION_PREFIX,
  parseQuarantineRecoveryAnswer,
  targetFromQuestionIdempotencyKey,
} from "./quarantine-recovery-shared";
import {
  invalidRecoveryAnswerInputDiagnostic,
  parseRecoveryAnswerInput,
} from "./recovery-answer-input";

const quarantineRecoveryAnswer: Processor = defineProcessor({
  id: "dome.health.quarantine-recovery-answer",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    {
      kind: "answer",
      questionProcessorId: "dome.health.quarantine-recovery-questions",
      idempotencyKeyPrefix: QUARANTINE_RECOVERY_QUESTION_PREFIX,
    },
  ],
  capabilities: [{ kind: "quarantine.recover", actions: ["reset"] }],
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
