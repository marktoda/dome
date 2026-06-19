// dome.health.orphan-run-recovery-answer — applies orphan run recovery.
//
// The processor emits RunRecoveryEffect rather than touching the run ledger.
// The engine-owned sink performs the transition after capability enforcement
// and ledgering.

import {
  runRecoveryEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { ORPHAN_RUN_RECOVERY_ERROR_REASON } from "../../../../src/ledger/runs";

import {
  orphanRunTargetFromQuestionIdempotencyKey,
  parseOrphanRunRecoveryAnswer,
} from "./orphan-run-recovery-shared";
import {
  invalidRecoveryAnswerInputDiagnostic,
  parseRecoveryAnswerInput,
} from "./recovery-answer-input";

const orphanRunRecoveryAnswer = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseRecoveryAnswerInput(ctx.input);
    if (input === null) {
      return [
        invalidRecoveryAnswerInputDiagnostic({
          code: "dome.health.orphan-run-recovery.invalid-answer-input",
          message:
            "Orphan run recovery answer handler received an invalid answer envelope.",
        }),
      ];
    }

    const target = orphanRunTargetFromQuestionIdempotencyKey(
      input.question.idempotencyKey,
    );
    const action = parseOrphanRunRecoveryAnswer(input.answer);
    if (target === null || action === null || action === "ignore") {
      return Object.freeze([]);
    }

    return [
      runRecoveryEffect({
        action,
        runId: target.runId,
        startedAt: target.startedAt,
        processorId: target.processorId,
        processorVersion: target.processorVersion,
        phase: target.phase,
        reason: ORPHAN_RUN_RECOVERY_ERROR_REASON,
        sourceRefs: input.question.sourceRefs,
      }),
    ];
  },
});

export default orphanRunRecoveryAnswer;
