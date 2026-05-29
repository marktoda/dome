// cli/commands/answer: resolve a durable QuestionEffect row.
//
// This is the small write-side companion to `dome inspect questions`.
// It owns CLI parsing/printing only; the projection accessor owns row
// lookup, multiple-choice validation, and mutation semantics.

import { resolve } from "node:path";

import {
  answerHandlersNeedDispatch,
  getQuestionAnswer,
  markAnswerHandlerAttempt,
  markAnswerHandlersFailed,
  markAnswerHandlersHandled,
} from "../../answers/question-answers";
import { answerQuestionDurably } from "../../engine/question-answering";
import { openVaultRuntime, type VaultRuntime } from "../../engine/vault-runtime";
import {
  runAnswerHandlersForQuestion,
  type AnswerHandlersForQuestionResult,
} from "../../engine/compiler-host";
import {
  getQuestionRecord,
  type AnswerQuestionResult,
  type QuestionRecord,
} from "../../projections/questions";

import { resolveShippedBundlesRoot } from "./sync-shared";
import { formatJson } from "../format";

export type RunAnswerOptions = {
  readonly id?: string | number | undefined;
  readonly value?: string | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
};

export async function runAnswer(
  options: RunAnswerOptions = {},
): Promise<number> {
  const id = parseQuestionId(options.id);
  if (id === null) {
    console.error(
      "dome answer: question id must be a positive integer. Usage: dome answer <question-id> [value]",
    );
    return 64;
  }

  const vaultPath = resolve(options.vault ?? process.cwd());
  const bundlesRoot = options.bundlesRoot ?? resolveShippedBundlesRoot();
  const runtimeResult = await openVaultRuntime({ vaultPath, bundlesRoot });
  if (!runtimeResult.ok) {
    console.error(
      `dome answer: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` first to initialize the vault.`,
    );
    return 1;
  }
  const runtime = runtimeResult.value;

  try {
    const rawValue = options.value?.trim();
    if (rawValue === undefined || rawValue.length === 0) {
      const record = getQuestionRecord(runtime.projectionDb, id);
      if (record === null) {
        console.error(`dome answer: question ${id} was not found.`);
        return 64;
      }
      if (options.json === true) {
        console.log(formatJson(recordToJson(record)));
      } else {
        console.log(formatQuestion(record));
      }
      return 0;
    }

    const result = answerQuestionDurably({
      projection: runtime.projectionDb,
      answers: runtime.answersDb,
      id,
      answer: rawValue,
    });
    const handlerResult =
      result.kind === "answered" || result.kind === "already-answered"
        ? await runAnswerHandlersIfNeeded({
            runtime,
            question: result.record,
          })
        : null;
    return printAnswerResult(result, options.json === true, handlerResult);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`dome answer: failed: ${msg}`);
    return 1;
  } finally {
    await runtime.close();
  }
}

async function runAnswerHandlersIfNeeded(opts: {
  readonly runtime: VaultRuntime;
  readonly question: QuestionRecord;
}): Promise<AnswerHandlersForQuestionResult | null> {
  const durable = getQuestionAnswer(
    opts.runtime.answersDb,
    opts.question.effect.idempotencyKey,
  );
  if (durable !== null && !answerHandlersNeedDispatch(durable)) {
    return null;
  }

  markAnswerHandlerAttempt(
    opts.runtime.answersDb,
    opts.question.effect.idempotencyKey,
    new Date().toISOString(),
  );
  const result = await runAnswerHandlersForQuestion(opts);
  if (result.kind === "skipped") {
    markAnswerHandlersFailed(opts.runtime.answersDb, {
      idempotencyKey: opts.question.effect.idempotencyKey,
      status: "skipped",
      error: result.reason,
    });
    return result;
  }

  const crash = result.result.diagnostics.find(
    (diagnostic) => diagnostic.code === "answer.dispatch-crashed",
  );
  if (crash !== undefined) {
    markAnswerHandlersFailed(opts.runtime.answersDb, {
      idempotencyKey: opts.question.effect.idempotencyKey,
      status: "failed",
      error: crash.message,
    });
    return result;
  }

  const failedRun = result.result.runs.find(
    (run) => run.executionStatus !== "succeeded",
  );
  if (failedRun !== undefined) {
    markAnswerHandlersFailed(opts.runtime.answersDb, {
      idempotencyKey: opts.question.effect.idempotencyKey,
      status: "failed",
      error:
        failedRun.executionError?.message ??
        `answer handler ${failedRun.processorId} finished with ${failedRun.executionStatus}`,
    });
    return result;
  }

  const routingDiagnostic = result.result.diagnostics.find(
    (diagnostic) =>
      diagnostic.severity === "error" || diagnostic.severity === "block",
  );
  if (routingDiagnostic !== undefined) {
    markAnswerHandlersFailed(opts.runtime.answersDb, {
      idempotencyKey: opts.question.effect.idempotencyKey,
      status: "failed",
      error: routingDiagnostic.message,
    });
    return result;
  }

  markAnswerHandlersHandled(opts.runtime.answersDb, {
    idempotencyKey: opts.question.effect.idempotencyKey,
    handledAt: new Date().toISOString(),
  });
  return result;
}

function printAnswerResult(
  result: AnswerQuestionResult,
  json: boolean,
  handlerResult: AnswerHandlersForQuestionResult | null,
): number {
  switch (result.kind) {
    case "not-found":
      console.error("dome answer: question was not found.");
      return 64;
    case "already-answered":
      if (json) {
        console.log(
          formatJson({
            status: "already-answered",
            question: recordToJson(result.record),
            handlers:
              handlerResult === null ? null : handlerResultToJson(handlerResult),
          }),
        );
      } else {
        const suffix =
          handlerResult?.kind === "handled"
            ? ` | handlers ${handlerResult.result.runs.length}`
            : handlerResult?.kind === "skipped"
              ? ` | handlers skipped (${handlerResult.reason})`
              : "";
        console.log(
          `question ${result.record.id} is already answered: ${result.record.answer ?? ""}${suffix}`,
        );
      }
      return 0;
    case "invalid-option":
      if (json) {
        console.log(
          formatJson({
            status: "invalid-option",
            options: result.options,
            question: recordToJson(result.record),
          }),
        );
      } else {
        console.error(
          `dome answer: invalid answer. Expected one of: ${result.options.join(", ")}`,
        );
      }
      return 64;
    case "answered":
      if (json) {
        console.log(
          formatJson({
            status: "answered",
            question: recordToJson(result.record),
            handlers:
              handlerResult === null ? null : handlerResultToJson(handlerResult),
          }),
        );
      } else {
        const suffix =
          handlerResult?.kind === "handled"
            ? ` | handlers ${handlerResult.result.runs.length}`
            : handlerResult?.kind === "skipped"
              ? ` | handlers skipped (${handlerResult.reason})`
              : "";
        console.log(
          `answered question ${result.record.id}: ${result.record.answer ?? ""}${suffix}`,
        );
      }
      return 0;
  }
}

function formatQuestion(record: QuestionRecord): string {
  const lines = [
    `question ${record.id} (${record.answeredAt === null ? "open" : "answered"})`,
    record.effect.question,
  ];
  if (record.effect.options !== undefined) {
    lines.push(`options: ${record.effect.options.join(", ")}`);
  }
  if (record.answer !== null) {
    lines.push(`answer: ${record.answer}`);
  }
  return lines.join("\n");
}

function recordToJson(record: QuestionRecord): Record<string, unknown> {
  return {
    id: record.id,
    status: record.answeredAt === null ? "open" : "answered",
    question: record.effect.question,
    options: record.effect.options ?? null,
    answer: record.answer,
    asked_at: record.askedAt,
    answered_at: record.answeredAt,
    idempotency_key: record.effect.idempotencyKey,
    processor_id: record.processorId,
    adopted_commit: record.adoptedCommit,
    source_refs: record.effect.sourceRefs,
  };
}

function handlerResultToJson(
  result: AnswerHandlersForQuestionResult,
): Record<string, unknown> {
  if (result.kind === "skipped") {
    return { status: "skipped", reason: result.reason };
  }
  const failed =
    result.result.runs.some((run) => run.executionStatus !== "succeeded") ||
    result.result.diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === "error" || diagnostic.severity === "block",
    );
  return {
    status: failed ? "failed" : "handled",
    adopted: result.adopted,
    runs: result.result.runs.map((run) => ({
      run_id: run.runId,
      processor_id: run.processorId,
      execution_status: run.executionStatus,
      execution_error: run.executionError ?? null,
      effect_count: run.effectCount,
      authorized_patch_count: run.authorizedPatchCount,
    })),
    sub_proposals: result.result.subProposalCount,
    rejected_patches: result.result.rejectedPatchCount,
    diagnostics: result.result.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
    })),
  };
}

function parseQuestionId(raw: string | number | undefined): number | null {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}
