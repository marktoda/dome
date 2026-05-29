// dome.health.quarantine-recovery-questions — asks whether to reset quarantines.
//
// The processor reads quarantined processor triggers through ctx.operational,
// emits QuestionEffects, and leaves mutation to the answer-handler path.

import {
  questionEffect,
  type Effect,
  type QuestionEffect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type OperationalQuarantineRow,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  QUARANTINE_RECOVERY_OPTIONS,
  quarantineRecoveryQuestionKey,
} from "./quarantine-recovery-shared";

const quarantineRecoveryQuestions: Processor = defineProcessor({
  id: "dome.health.quarantine-recovery-questions",
  version: "0.1.0",
  phase: "garden",
  triggers: [{ kind: "schedule", cron: "* * * * *" }],
  capabilities: [{ kind: "quarantine.read" }, { kind: "question.ask" }],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (ctx.operational === undefined) {
      throw new Error(
        "dome.health.quarantine-recovery-questions: ctx.operational is undefined; health processors require an OperationalQueryView",
      );
    }

    return Object.freeze(
      ctx.operational.quarantines().map(questionForQuarantine),
    );
  },
});

export default quarantineRecoveryQuestions;

function questionForQuarantine(row: OperationalQuarantineRow): QuestionEffect {
  return questionEffect({
    question:
      `Processor ${row.processorId} is quarantined for trigger ` +
      `${row.triggerHash.slice(0, 12)} after ` +
      `${row.consecutiveRetryableFailures} retryable failure(s). Reset it?`,
    options: QUARANTINE_RECOVERY_OPTIONS,
    sourceRefs: [],
    idempotencyKey: quarantineRecoveryQuestionKey(row),
  });
}
