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
  readonly handlerStatus: AnswerHandlerStatus;
  readonly handlerAttempts: number;
  readonly lastHandlerAttemptAt: string | null;
  readonly handledAt: string | null;
  readonly lastHandlerError: string | null;
};

export type AnswerHandlerStatus = "pending" | "handled" | "failed" | "skipped";

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
       question, processor_id, adopted_commit,
       handler_status, handler_attempts, last_handler_attempt_at,
       handled_at, last_handler_error
FROM question_answers
ORDER BY answered_at, idempotency_key
`.trim();

const QUERY_BY_KEY_SQL = `
SELECT idempotency_key, answer, answered_at, question_id,
       question, processor_id, adopted_commit,
       handler_status, handler_attempts, last_handler_attempt_at,
       handled_at, last_handler_error
FROM question_answers
WHERE idempotency_key = ?
`.trim();

const MARK_ATTEMPT_SQL = `
UPDATE question_answers
SET handler_attempts = handler_attempts + 1,
    last_handler_attempt_at = ?,
    handler_status = 'pending',
    last_handler_error = NULL
WHERE idempotency_key = ?
`.trim();

const MARK_HANDLED_SQL = `
UPDATE question_answers
SET handler_status = 'handled',
    handled_at = ?,
    last_handler_error = NULL
WHERE idempotency_key = ?
`.trim();

const MARK_FAILED_SQL = `
UPDATE question_answers
SET handler_status = ?,
    last_handler_error = ?
WHERE idempotency_key = ?
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
    handlerStatus: "pending",
    handlerAttempts: 0,
    lastHandlerAttemptAt: null,
    handledAt: null,
    lastHandlerError: null,
  });
}

export function getQuestionAnswer(
  db: AnswersDb,
  idempotencyKey: string,
): QuestionAnswerRecord | null {
  const row = db.raw
    .query<QuestionAnswerRow, [string]>(QUERY_BY_KEY_SQL)
    .get(idempotencyKey);
  return row === null ? null : rowToRecord(row);
}

export function queryQuestionAnswers(
  db: AnswersDb,
): ReadonlyArray<QuestionAnswerRecord> {
  const rows = db.raw.query<QuestionAnswerRow, []>(QUERY_ALL_SQL).all();
  return Object.freeze(rows.map(rowToRecord));
}

export function answerHandlersNeedDispatch(record: QuestionAnswerRecord): boolean {
  return record.handlerStatus !== "handled";
}

export function markAnswerHandlerAttempt(
  db: AnswersDb,
  idempotencyKey: string,
  attemptedAt: string,
): void {
  db.raw.query(MARK_ATTEMPT_SQL).run(attemptedAt, idempotencyKey);
}

export function markAnswerHandlersHandled(
  db: AnswersDb,
  opts: {
    readonly idempotencyKey: string;
    readonly handledAt: string;
  },
): void {
  db.raw.query(MARK_HANDLED_SQL).run(opts.handledAt, opts.idempotencyKey);
}

export function markAnswerHandlersFailed(
  db: AnswersDb,
  opts: {
    readonly idempotencyKey: string;
    readonly status: Exclude<AnswerHandlerStatus, "pending" | "handled">;
    readonly error: string;
  },
): void {
  db.raw.query(MARK_FAILED_SQL).run(
    opts.status,
    opts.error,
    opts.idempotencyKey,
  );
}

type QuestionAnswerRow = {
  readonly idempotency_key: string;
  readonly answer: string;
  readonly answered_at: string;
  readonly question_id: number | null;
  readonly question: string;
  readonly processor_id: string;
  readonly adopted_commit: string;
  readonly handler_status: string;
  readonly handler_attempts: number;
  readonly last_handler_attempt_at: string | null;
  readonly handled_at: string | null;
  readonly last_handler_error: string | null;
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
    handlerStatus: parseHandlerStatus(row.handler_status),
    handlerAttempts: row.handler_attempts,
    lastHandlerAttemptAt: row.last_handler_attempt_at,
    handledAt: row.handled_at,
    lastHandlerError: row.last_handler_error,
  });
}

function parseHandlerStatus(value: string): AnswerHandlerStatus {
  if (
    value === "pending" ||
    value === "handled" ||
    value === "failed" ||
    value === "skipped"
  ) {
    return value;
  }
  return "failed";
}
