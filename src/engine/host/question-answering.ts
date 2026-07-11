// engine/host/question-answering: durable answer orchestration.
//
// `dome resolve` / `dome answer` records a durable answer, then this module
// dispatches matching garden-phase answer handlers.

import type { DiagnosticEffect } from "../../core/effect";
import type { RunnerExecutionStatus } from "../core/runner-contract";

import {
  answerHandlersNeedDispatch,
  getQuestionAnswer,
  markAnswerHandlerAttempt,
  markAnswerHandlersFailed,
  markAnswerHandlersHandled,
} from "../../answers/question-answers";
import type { QuestionRecord } from "../../projections/questions";
import type { VaultRuntime } from "./vault-runtime";
import {
  runAnswerHandlersForQuestion,
  type AnswerHandlersForQuestionResult,
} from "./compiler-host";
export {
  answerQuestionDurably,
  type AnswerQuestionDurablyOpts,
} from "../operational/question-answer-recording";

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

  const failure = answerHandlerFailure(result.result);
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

function answerHandlerFailure(result: {
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
  readonly runs: ReadonlyArray<{
    readonly processorId: string;
    readonly executionStatus: RunnerExecutionStatus;
    readonly executionError?: { readonly message?: string };
  }>;
}): string | null {
  const crash = result.diagnostics.find(
    (diagnostic) => diagnostic.code === "answer.dispatch-crashed",
  );
  if (crash !== undefined) return crash.message;
  const failedRun = result.runs.find(
    (run) => run.executionStatus !== "succeeded",
  );
  if (failedRun !== undefined) {
    return failedRun.executionError?.message ??
      `answer handler ${failedRun.processorId} finished with ${failedRun.executionStatus}`;
  }
  return result.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error" || diagnostic.severity === "block",
  )?.message ?? null;
}
