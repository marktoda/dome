// engine/operational/question-expiry: release OPEN questions whose subject
// processor no longer exists.
//
// A QuestionEffect's "subject" is whichever processor the question is
// actually about: the emitting `processor_id` by default, or
// `metadata.subjectProcessorId` when the emitter is asking on behalf of a
// different processor (the health-recovery shape — e.g.
// `dome.health.orphan-run-recovery-questions` asking about a stuck run's
// `processorId`). When a bundle retires, its questions can never be answered
// through the normal flow (no handler will ever run for it again) and would
// otherwise re-render forever. This pump releases them.
//
// Deliberately NOT a mirror of `question-auto-resolution.ts`'s handler
// dispatch: there is no handler to run for a retired subject, so expiry
// writes the durable answer row directly (`answer: "expired"`,
// `answered_by: "expired"`) and marks it `handler_status: "handled"` without
// ever calling `runAnswerHandlers`. It also does not honor a question's
// `options` allow-list — "expired" is an engine-forced terminal state, not a
// value the emitting processor offered.
//
// Cheap and idempotent: only OPEN questions are read each pass, and once a
// row is expired it carries `answered_at`, so it drops out of the open set
// and a subsequent pass is a no-op.

import type { AnswersDb } from "../../answers/db";
import {
  markAnswerHandlersHandled,
  recordQuestionAnswer,
} from "../../answers/question-answers";
import { diagnosticEffect } from "../../core/effect";
import type { ApplyEffectSinks } from "../core/apply-effect";
import { recordDiagnosticsViaSink } from "../core/diagnostics";
import type { ProjectionDb } from "../../projections/db";
import {
  applyQuestionAnswer,
  queryQuestionRecords,
  type QuestionRecord,
} from "../../projections/questions";
import type { ProcessorRegistry } from "../../processors/registry";

export type QuestionExpiryDeps = {
  /** Active processor ids — a question whose subject is absent expires. */
  readonly registry: ProcessorRegistry;
  /** The questions store accessor, same handle `question-auto-resolution.ts` reads. */
  readonly questions: ProjectionDb;
  readonly answers: AnswersDb;
  readonly recordDiagnostic: ApplyEffectSinks["recordDiagnostic"];
  readonly now: () => Date;
};

const EXPIRY_PROCESSOR_ID = "engine.question-expiry";

/**
 * Expire every OPEN question whose subject processor (the emitting
 * `processor_id`, or `metadata.subjectProcessorId` when set) is no longer in
 * the active registry. Writes a durable answer row (`answer: "expired"`,
 * `answered_by: "expired"`, `handler_status: "handled"`), mirrors it onto the
 * rebuildable projection row, and raises one info diagnostic per expiry.
 */
export async function expireOrphanSubjectQuestions(
  deps: QuestionExpiryDeps,
): Promise<{ readonly expired: number }> {
  const openQuestions = queryQuestionRecords(deps.questions, {
    resolved: false,
  });

  let expired = 0;
  for (const question of openQuestions) {
    const retiredSubject = retiredSubjectOf(question, deps.registry);
    if (retiredSubject === null) continue;

    expireQuestion(question, deps);
    await recordDiagnosticsViaSink({
      sinks: { recordDiagnostic: deps.recordDiagnostic },
      diagnostics: [
        diagnosticEffect({
          severity: "info",
          code: "question.expired-subject-retired",
          message:
            `Question ${question.id} expired: subject processor ` +
            `${retiredSubject} is retired.`,
          sourceRefs: question.effect.sourceRefs,
        }),
      ],
      processorId: EXPIRY_PROCESSOR_ID,
      proposalId: null,
    });
    expired += 1;
  }

  return Object.freeze({ expired });
}

/**
 * The retired processor id a question's subject resolves to, or `null` when
 * both the emitter and any declared `subjectProcessorId` are still active.
 * The emitting processor is checked first: a retired emitter always expires
 * its own questions regardless of `subjectProcessorId`.
 */
function retiredSubjectOf(
  question: QuestionRecord,
  registry: ProcessorRegistry,
): string | null {
  if (registry.get(question.processorId) === undefined) {
    return question.processorId;
  }
  const subjectProcessorId = question.effect.metadata?.subjectProcessorId;
  if (
    subjectProcessorId !== undefined &&
    registry.get(subjectProcessorId) === undefined
  ) {
    return subjectProcessorId;
  }
  return null;
}

/**
 * Write the durable + projection answer rows directly (not through
 * `answerQuestionDurably`): that helper rejects answers outside the
 * question's `options` allow-list, which is exactly right for real answers
 * but wrong here — "expired" is an engine-forced terminal state a question's
 * own options never offer.
 */
function expireQuestion(question: QuestionRecord, deps: QuestionExpiryDeps): void {
  const answeredAt = deps.now().toISOString();
  recordQuestionAnswer(deps.answers, {
    idempotencyKey: question.effect.idempotencyKey,
    answer: "expired",
    answeredAt,
    questionId: question.id,
    question: question.effect.question,
    processorId: question.processorId,
    adoptedCommit: question.adoptedCommit,
    answeredBy: "expired",
  });
  applyQuestionAnswer(deps.questions, {
    idempotencyKey: question.effect.idempotencyKey,
    answer: "expired",
    answeredAt,
    answeredBy: "expired",
  });
  markAnswerHandlersHandled(deps.answers, {
    idempotencyKey: question.effect.idempotencyKey,
    handledAt: answeredAt,
  });
}
