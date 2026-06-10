// surface/answer: the `dome.answer/v1` document mappers.
//
// Shared by `dome resolve` / `dome answer` (`--json` mode) and the MCP
// `resolve` tool. The projection accessor owns row lookup, multiple-choice
// validation, and mutation semantics; these mappers only render records and
// handler dispatches as the shared document bodies.

import type { AnswerHandlerDispatchResult } from "../engine/host/question-answering";
import type { QuestionRecord } from "../projections/questions";

export const ANSWER_SCHEMA = "dome.answer/v1";

/**
 * Render a question record as the `dome.answer/v1` question body — shared
 * by `dome resolve --json` and the MCP `resolve` tool.
 */
export function questionRecordJson(record: QuestionRecord): Record<string, unknown> {
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

/** Render an answer-handler dispatch as its `dome.answer/v1` body. */
export function answerHandlersJson(
  result: NonNullable<AnswerHandlerDispatchResult>,
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
