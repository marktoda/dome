// Durable question-answer accessors.
//
// The projection table holds current question rows; this store holds the
// human answer by QuestionEffect.idempotencyKey so rebuilds can rehydrate
// projection state without giving processors direct write access.

import type { AnswersDb } from "./db";

export type QuestionAnswerRecord = {
  readonly idempotencyKey: string;
  readonly answer: string;
  readonly answeredAt: string;
  readonly questionId: number | null;
  readonly question: string;
  readonly processorId: string;
  readonly adoptedCommit: string;
};

export type RecordQuestionAnswerOpts = {
  readonly idempotencyKey: string;
  readonly answer: string;
  readonly answeredAt: string;
  readonly questionId: number;
  readonly question: string;
  readonly processorId: string;
  readonly adoptedCommit: string;
};

const UPSERT_SQL = `
INSERT INTO question_answers (
  idempotency_key, answer, answered_at, question_id,
  question, processor_id, adopted_commit
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(idempotency_key) DO UPDATE SET
  answer = excluded.answer,
  answered_at = excluded.answered_at,
  question_id = excluded.question_id,
  question = excluded.question,
  processor_id = excluded.processor_id,
  adopted_commit = excluded.adopted_commit
`.trim();

const QUERY_ALL_SQL = `
SELECT idempotency_key, answer, answered_at, question_id,
       question, processor_id, adopted_commit
FROM question_answers
ORDER BY answered_at, idempotency_key
`.trim();

export function recordQuestionAnswer(
  db: AnswersDb,
  opts: RecordQuestionAnswerOpts,
): QuestionAnswerRecord {
  db.raw.query(UPSERT_SQL).run(
    opts.idempotencyKey,
    opts.answer,
    opts.answeredAt,
    opts.questionId,
    opts.question,
    opts.processorId,
    opts.adoptedCommit,
  );
  return Object.freeze({
    idempotencyKey: opts.idempotencyKey,
    answer: opts.answer,
    answeredAt: opts.answeredAt,
    questionId: opts.questionId,
    question: opts.question,
    processorId: opts.processorId,
    adoptedCommit: opts.adoptedCommit,
  });
}

export function queryQuestionAnswers(
  db: AnswersDb,
): ReadonlyArray<QuestionAnswerRecord> {
  const rows = db.raw.query<QuestionAnswerRow, []>(QUERY_ALL_SQL).all();
  return Object.freeze(rows.map(rowToRecord));
}

type QuestionAnswerRow = {
  readonly idempotency_key: string;
  readonly answer: string;
  readonly answered_at: string;
  readonly question_id: number | null;
  readonly question: string;
  readonly processor_id: string;
  readonly adopted_commit: string;
};

function rowToRecord(row: QuestionAnswerRow): QuestionAnswerRecord {
  return Object.freeze({
    idempotencyKey: row.idempotency_key,
    answer: row.answer,
    answeredAt: row.answered_at,
    questionId: row.question_id,
    question: row.question,
    processorId: row.processor_id,
    adoptedCommit: row.adopted_commit,
  });
}
