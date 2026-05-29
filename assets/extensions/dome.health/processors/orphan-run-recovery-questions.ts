// dome.health.orphan-run-recovery-questions — asks whether to fail stuck runs.
//
// The processor reads orphaned running rows through ctx.operational, emits
// QuestionEffects, and leaves mutation to the answer-handler path.

import {
  questionEffect,
  type Effect,
  type QuestionEffect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type OperationalRunRow,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  ORPHAN_RUN_RECOVERY_OPTIONS,
  orphanRunRecoveryQuestionKey,
} from "./orphan-run-recovery-shared";

const orphanRunRecoveryQuestions: Processor = defineProcessor({
  id: "dome.health.orphan-run-recovery-questions",
  version: "0.1.0",
  phase: "garden",
  triggers: [{ kind: "schedule", cron: "* * * * *" }],
  capabilities: [
    { kind: "run.read", statuses: ["running"] },
    { kind: "question.ask" },
  ],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (ctx.operational === undefined) {
      throw new Error(
        "dome.health.orphan-run-recovery-questions: ctx.operational is undefined; health processors require an OperationalQueryView",
      );
    }

    return Object.freeze(
      ctx.operational.orphanRuns().map(questionForOrphanRun),
    );
  },
});

export default orphanRunRecoveryQuestions;

function questionForOrphanRun(row: OperationalRunRow): QuestionEffect {
  return questionEffect({
    question:
      `Run ${row.id} for processor ${row.processorId} has been running ` +
      `since ${row.startedAt}. Mark it failed?`,
    options: ORPHAN_RUN_RECOVERY_OPTIONS,
    sourceRefs: [],
    idempotencyKey: orphanRunRecoveryQuestionKey({
      runId: row.id,
      startedAt: row.startedAt,
      processorId: row.processorId,
      processorVersion: row.processorVersion,
      phase: row.phase,
    }),
  });
}
