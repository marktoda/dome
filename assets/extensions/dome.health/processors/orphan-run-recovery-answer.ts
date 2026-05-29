// dome.health.orphan-run-recovery-answer — applies orphan run recovery.
//
// The processor emits RunRecoveryEffect rather than touching the run ledger.
// The engine-owned sink performs the transition after capability enforcement
// and ledgering.

import {
  diagnosticEffect,
  runRecoveryEffect,
  type Effect,
  type QuestionEffect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  ORPHAN_RUN_RECOVERY_QUESTION_PREFIX,
  orphanRunTargetFromQuestionIdempotencyKey,
  parseOrphanRunRecoveryAnswer,
} from "./orphan-run-recovery-shared";

const orphanRunRecoveryAnswer: Processor = defineProcessor({
  id: "dome.health.orphan-run-recovery-answer",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    {
      kind: "answer",
      idempotencyKeyPrefix: ORPHAN_RUN_RECOVERY_QUESTION_PREFIX,
    },
  ],
  capabilities: [{ kind: "run.recover", actions: ["fail"] }],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseAnswerInput(ctx.input);
    if (input === null) {
      return [
        diagnosticEffect({
          severity: "error",
          code: "dome.health.orphan-run-recovery.invalid-answer-input",
          message:
            "Orphan run recovery answer handler received an invalid answer envelope.",
          sourceRefs: [],
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
        reason: "dome.health: mark orphaned processor run failed",
        sourceRefs: input.question.sourceRefs,
      }),
    ];
  },
});

export default orphanRunRecoveryAnswer;

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
