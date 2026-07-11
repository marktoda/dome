// Durable question-answer accessors.
//
// The projection table holds current question rows; this store holds the
// durable answer by QuestionEffect.idempotencyKey so rebuilds can rehydrate
// projection state without giving processors direct write access.

import { mapRows } from "../sqlite/rows";
import { z } from "zod";
import {
  blobOid,
  commitOid,
  sourceRef,
  SourceRefSchema,
  type SourceRef,
} from "../core/source-ref";
import type { AnswersDb } from "./db";

export type AgentAnswerContext = {
  readonly kind: "agent";
  readonly reason: string;
  readonly evidence: ReadonlyArray<SourceRef>;
};

const AgentAnswerContextSchema = z.object({
  kind: z.literal("agent"),
  reason: z.string().min(1),
  evidence: z.array(SourceRefSchema),
}).strict();

export type QuestionAnswerRecord = {
  readonly idempotencyKey: string;
  readonly answer: string;
  readonly answeredAt: string;
  readonly questionId: number | null;
  readonly question: string;
  readonly processorId: string;
  readonly adoptedCommit: string;
  readonly answeredBy: QuestionAnsweredBy;
  readonly answerContext: AgentAnswerContext | null;
  readonly handlerStatus: AnswerHandlerStatus;
  readonly handlerAttempts: number;
  readonly lastHandlerAttemptAt: string | null;
  readonly handledAt: string | null;
  readonly lastHandlerError: string | null;
};

export type AnswerHandlerStatus = "pending" | "handled" | "failed" | "skipped";

/** Who supplied the durable answer. `auto` remains for rows written by the
 * retired metadata-only pump; new autonomous decisions use `agent` plus an
 * evidence context. */
export type QuestionAnsweredBy = "owner" | "agent" | "auto" | "expired";

export type RecordQuestionAnswerOpts = {
  readonly idempotencyKey: string;
  readonly answer: string;
  readonly answeredAt: string;
  readonly questionId: number;
  readonly question: string;
  readonly processorId: string;
  readonly adoptedCommit: string;
  readonly answeredBy: QuestionAnsweredBy;
  readonly answerContext?: AgentAnswerContext;
};

const INSERT_ANSWER_SQL = `
INSERT INTO question_answers (
  idempotency_key, answer, answered_at, question_id,
  question, processor_id, adopted_commit, answered_by, answer_context_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(idempotency_key) DO NOTHING
`.trim();

const QUERY_ALL_SQL = `
SELECT idempotency_key, answer, answered_at, question_id,
       question, processor_id, adopted_commit, answered_by, answer_context_json,
       handler_status, handler_attempts, last_handler_attempt_at,
       handled_at, last_handler_error
FROM question_answers
ORDER BY answered_at, idempotency_key
`.trim();

const QUERY_BY_KEY_SQL = `
SELECT idempotency_key, answer, answered_at, question_id,
       question, processor_id, adopted_commit, answered_by, answer_context_json,
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

/**
 * First-answer-wins durable write. Multiple harnesses
 * may investigate the same derived packet concurrently; the durable answer
 * row is the compare-and-set seam that prevents a later completion from
 * overwriting the winner.
 */
export function recordQuestionAnswer(
  db: AnswersDb,
  opts: RecordQuestionAnswerOpts,
):
  | { readonly kind: "recorded"; readonly record: QuestionAnswerRecord }
  | { readonly kind: "existing"; readonly record: QuestionAnswerRecord } {
  const result = db.raw.query(INSERT_ANSWER_SQL).run(
    opts.idempotencyKey,
    opts.answer,
    opts.answeredAt,
    opts.questionId,
    opts.question,
    opts.processorId,
    opts.adoptedCommit,
    opts.answeredBy,
    opts.answerContext === undefined ? null : JSON.stringify(opts.answerContext),
  );
  const record = getQuestionAnswer(db, opts.idempotencyKey);
  if (record === null) {
    throw new Error("question answer insert completed without a durable row");
  }
  return Object.freeze({
    kind: result.changes === 1 ? "recorded" as const : "existing" as const,
    record,
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
  return mapRows(rows, rowToRecord);
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
  readonly answered_by: string;
  readonly answer_context_json: string | null;
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
    answeredBy: parseAnsweredBy(row.answered_by),
    answerContext: parseAnswerContext(row.answer_context_json),
    handlerStatus: parseHandlerStatus(row.handler_status),
    handlerAttempts: row.handler_attempts,
    lastHandlerAttemptAt: row.last_handler_attempt_at,
    handledAt: row.handled_at,
    lastHandlerError: row.last_handler_error,
  });
}

function parseAnsweredBy(value: string): QuestionAnsweredBy {
  if (value === "agent" || value === "auto" || value === "expired") return value;
  return "owner";
}

function parseAnswerContext(value: string | null): AgentAnswerContext | null {
  if (value === null) return null;
  try {
    const parsed = AgentAnswerContextSchema.safeParse(JSON.parse(value));
    if (!parsed.success) return null;
    const evidence = parsed.data.evidence.map((ref) => {
      const range = ref.range === undefined
        ? undefined
        : Object.freeze({
            startLine: ref.range.startLine,
            endLine: ref.range.endLine,
            ...(ref.range.startChar !== undefined
              ? { startChar: ref.range.startChar }
              : {}),
            ...(ref.range.endChar !== undefined
              ? { endChar: ref.range.endChar }
              : {}),
          });
      return sourceRef({
        path: ref.path,
        commit: commitOid(ref.commit),
        ...(ref.blob !== undefined ? { blob: blobOid(ref.blob) } : {}),
        ...(range !== undefined ? { range } : {}),
        ...(ref.stableId !== undefined ? { stableId: ref.stableId } : {}),
      });
    });
    return Object.freeze({
      kind: "agent" as const,
      reason: parsed.data.reason,
      evidence: Object.freeze(evidence),
    });
  } catch {
    return null;
  }
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
