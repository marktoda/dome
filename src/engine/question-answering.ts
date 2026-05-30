// engine/question-answering: durable answer orchestration.
//
// `dome resolve` / `dome answer` crosses two state surfaces: the rebuildable
// projection row the user selects by id, and the durable operational record
// keyed by QuestionEffect.idempotencyKey. This module owns that cross-DB
// boundary so projection accessors stay table-local and processors never gain
// mutation rights.

import type { AnswersDb } from "../answers/db";
import {
  answerHandlersNeedDispatch,
  getQuestionAnswer,
  markAnswerHandlerAttempt,
  markAnswerHandlersFailed,
  markAnswerHandlersHandled,
  recordQuestionAnswer,
} from "../answers/question-answers";
import type { ProjectionDb } from "../projections/db";
import {
  applyQuestionAnswer,
  getQuestionRecord,
  type AnswerQuestionResult,
  type QuestionRecord,
} from "../projections/questions";
import type { VaultRuntime } from "./vault-runtime";
import {
  runAnswerHandlersForQuestion,
  type AnswerHandlersForQuestionResult,
} from "./compiler-host";

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

export type AnswerHandlerDispatchResult =
  AnswerHandlersForQuestionResult | null;

export async function dispatchAnswerHandlersIfNeeded(opts: {
  readonly runtime: VaultRuntime;
  readonly question: QuestionRecord;
  readonly now?: () => Date;
}): Promise<AnswerHandlerDispatchResult> {
  const idempotencyKey = opts.question.effect.idempotencyKey;
  const durable = getQuestionAnswer(opts.runtime.answersDb, idempotencyKey);
  if (durable !== null && !answerHandlersNeedDispatch(durable)) {
    return null;
  }

  const now = opts.now ?? ((): Date => new Date());
  markAnswerHandlerAttempt(
    opts.runtime.answersDb,
    idempotencyKey,
    now().toISOString(),
  );
  const result = await runAnswerHandlersForQuestion(opts);

  if (result.kind === "skipped") {
    markAnswerHandlersFailed(opts.runtime.answersDb, {
      idempotencyKey,
      status: "skipped",
      error: result.reason,
    });
    return result;
  }

  const failure = answerHandlerFailure(result);
  if (failure !== null) {
    markAnswerHandlersFailed(opts.runtime.answersDb, {
      idempotencyKey,
      status: "failed",
      error: failure,
    });
    return result;
  }

  markAnswerHandlersHandled(opts.runtime.answersDb, {
    idempotencyKey,
    handledAt: now().toISOString(),
  });
  return result;
}

function answerHandlerFailure(
  result: Extract<AnswerHandlersForQuestionResult, { readonly kind: "handled" }>,
): string | null {
  const crash = result.result.diagnostics.find(
    (diagnostic) => diagnostic.code === "answer.dispatch-crashed",
  );
  if (crash !== undefined) return crash.message;

  const failedRun = result.result.runs.find(
    (run) => run.executionStatus !== "succeeded",
  );
  if (failedRun !== undefined) {
    return (
      failedRun.executionError?.message ??
      `answer handler ${failedRun.processorId} finished with ${failedRun.executionStatus}`
    );
  }

  const routingDiagnostic = result.result.diagnostics.find(
    (diagnostic) =>
      diagnostic.severity === "error" || diagnostic.severity === "block",
  );
  return routingDiagnostic?.message ?? null;
}
