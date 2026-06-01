// dome.health.outbox-recovery-questions — asks how to handle failed outbox rows.
//
// The processor reads failed rows through ctx.operational, emits QuestionEffects,
// and leaves all mutation to the answer-handler path.

import {
  questionEffect,
  type Effect,
  type QuestionEffect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type OperationalOutboxRow,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  OUTBOX_RECOVERY_FAILURE_SEPARATOR,
  OUTBOX_RECOVERY_OPTIONS,
  OUTBOX_RECOVERY_QUESTION_PREFIX,
} from "./outbox-recovery-shared";

const outboxRecoveryQuestions: Processor = defineProcessor({
  id: "dome.health.outbox-recovery-questions",
  version: "0.1.1",
  phase: "garden",
  triggers: [{ kind: "schedule", cron: "* * * * *" }],
  capabilities: [{ kind: "question.ask" }],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (ctx.operational === undefined) {
      throw new Error(
        "dome.health.outbox-recovery-questions: ctx.operational is undefined; health processors require an OperationalQueryView",
      );
    }

    return Object.freeze(
      ctx.operational
        .outbox({ status: "failed" })
        .map((row) => questionForFailedRow(row)),
    );
  },
});

export default outboxRecoveryQuestions;

function questionForFailedRow(row: OperationalOutboxRow): QuestionEffect {
  return questionEffect({
    question:
      `Outbox action ${row.idempotencyKey} (${row.capability}) failed after ` +
      `${row.attempts}/${row.maxAttempts} attempt(s). Retry or abandon it?`,
    options: OUTBOX_RECOVERY_OPTIONS,
    sourceRefs: row.sourceRefs,
    idempotencyKey:
      `${OUTBOX_RECOVERY_QUESTION_PREFIX}${row.idempotencyKey}` +
      `${OUTBOX_RECOVERY_FAILURE_SEPARATOR}${failureToken(row)}`,
    metadata: {
      risk: "medium",
      confidence: 1,
      recommendedAnswer: "retry",
      automationPolicy: "owner-needed",
      ownerNeededReason:
        "Retrying or abandoning a failed external action can affect external state.",
    },
  });
}

function failureToken(row: OperationalOutboxRow): string {
  return encodeURIComponent(
    JSON.stringify({
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt,
      lastError: row.lastError,
    }),
  );
}
