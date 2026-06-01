// engine/question-answer-recording: durable QuestionEffect answer writes.
//
// This module deliberately does not dispatch answer handlers. It owns only the
// cross-DB write from a rebuildable projection question row into durable
// answers.db, plus the projection-row answered mirror. CLI resolution,
// background auto-resolution, and future surfaces can share it while keeping
// handler dispatch in their own runtime host.

import type { AnswersDb } from "../answers/db";
import { recordQuestionAnswer } from "../answers/question-answers";
import type { ProjectionDb } from "../projections/db";
import {
  applyQuestionAnswer,
  getQuestionRecord,
  type AnswerQuestionResult,
} from "../projections/questions";

export type AnswerQuestionDurablyOpts = {
  readonly projection: ProjectionDb;
  readonly answers: AnswersDb;
  readonly id: number;
  readonly answer: string;
  readonly now?: () => Date;
};

export function answerQuestionDurably(
  opts: AnswerQuestionDurablyOpts,
): AnswerQuestionResult {
  const record = getQuestionRecord(opts.projection, opts.id);
  if (record === null) return { kind: "not-found" };
  if (record.answeredAt !== null) {
    return Object.freeze({ kind: "already-answered", record });
  }

  const choices = record.effect.options;
  if (choices !== undefined && !choices.includes(opts.answer)) {
    return Object.freeze({
      kind: "invalid-option",
      record,
      options: choices,
    });
  }

  const answeredAt = (opts.now ?? ((): Date => new Date()))().toISOString();
  recordQuestionAnswer(opts.answers, {
    idempotencyKey: record.effect.idempotencyKey,
    answer: opts.answer,
    answeredAt,
    questionId: record.id,
    question: record.effect.question,
    processorId: record.processorId,
    adoptedCommit: record.adoptedCommit,
  });
  applyQuestionAnswer(opts.projection, {
    idempotencyKey: record.effect.idempotencyKey,
    answer: opts.answer,
    answeredAt,
  });

  const answered = getQuestionRecord(opts.projection, opts.id);
  if (answered === null) return { kind: "not-found" };
  return Object.freeze({ kind: "answered", record: answered });
}
