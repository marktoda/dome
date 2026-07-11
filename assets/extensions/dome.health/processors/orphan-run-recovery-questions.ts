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
  defineProcessorImplementation,
  type OperationalRunRow,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  ORPHAN_RUN_RECOVERY_OPTIONS,
  orphanRunRecoveryQuestionKey,
} from "./orphan-run-recovery-shared";

const orphanRunRecoveryQuestions = defineProcessorImplementation({
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
    metadata: {
      resolutionMode: "dispatch",
      risk: "low",
      confidence: 1,
      recommendedAnswer: "fail",
      automationPolicy: "agent-safe",
      // Deliberately NOT stamped with `subjectProcessorId`. Subject-liveness
      // expiry (src/engine/operational/question-expiry.ts) releases any open
      // question whose subject is a retired processor — right for the
      // quarantine-recovery shape, whose GC-owned quarantine row the retired
      // processor makes moot. But the stuck run row in runs.db survives its
      // processor's retirement regardless, and THIS question is the run's
      // only disposition path (`fail` is how the row ever leaves `running`).
      // Stamping the run's processor here would let the same tick that
      // raises the question expire it, permanently burying an undisposable
      // orphan run behind a durable "expired" answer. So this question's
      // only subject is its own (always-active-while-installed) emitter.
    },
  });
}
