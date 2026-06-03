// cli/commands/answer: resolve a durable QuestionEffect row.
//
// This is the small write-side companion behind `dome resolve` and the
// compatibility `dome answer` command.
// It owns CLI parsing/printing only; the projection accessor owns row
// lookup, multiple-choice validation, and mutation semantics.

import { resolve } from "node:path";

import {
  answerQuestionDurably,
  dispatchAnswerHandlersIfNeeded,
  type AnswerHandlerDispatchResult,
} from "../../engine/question-answering";
import { openVaultRuntime } from "../../engine/vault-runtime";
import {
  getQuestionRecord,
  type AnswerQuestionResult,
  type QuestionRecord,
} from "../../projections/questions";

import { resolveBundleRoots } from "./sync-shared";
import { formatJson } from "../format";
import {
  formatCommand,
  formatHeadline,
  formatSummaryRows,
  pushSection,
} from "../human-output";

const ANSWER_SCHEMA = "dome.answer/v1";

export type RunAnswerOptions = {
  readonly id?: string | number | undefined;
  readonly value?: string | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
  readonly commandLabel?: string | undefined;
};

export async function runAnswer(
  options: RunAnswerOptions = {},
): Promise<number> {
  const commandLabel = options.commandLabel ?? "dome answer";
  const id = parseQuestionId(options.id);
  if (id === null) {
    printAnswerError({
      commandLabel,
      json: options.json === true,
      error: "answer-usage",
      message:
        `${commandLabel}: question id must be a positive integer. ` +
        `Usage: ${commandLabel} <question-id> [value]`,
    });
    return 64;
  }

  const vaultPath = resolve(options.vault ?? process.cwd());
  const bundleRoots = resolveBundleRoots({
    vaultPath,
    bundlesRoot: options.bundlesRoot,
  });
  const runtimeResult = await openVaultRuntime({ vaultPath, ...bundleRoots });
  if (!runtimeResult.ok) {
    printAnswerError({
      commandLabel,
      json: options.json === true,
      error: runtimeResult.error.kind,
      message:
        `${commandLabel}: openVaultRuntime failed (${runtimeResult.error.kind}). ` +
        "Run `dome init` first to initialize the vault.",
    });
    return 1;
  }
  const runtime = runtimeResult.value;

  try {
    const rawValue = options.value?.trim();
    if (rawValue === undefined || rawValue.length === 0) {
      const record = getQuestionRecord(runtime.projectionDb, id);
      if (record === null) {
        printAnswerError({
          commandLabel,
          json: options.json === true,
          error: "question-not-found",
          message: `${commandLabel}: question ${id} was not found.`,
        });
        return 64;
      }
      if (options.json === true) {
        console.log(formatJson({
          schema: ANSWER_SCHEMA,
          ...recordToJson(record),
        }));
      } else {
        console.log(formatQuestion(commandLabel, record));
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
        ? await dispatchAnswerHandlersIfNeeded({
            runtime,
            question: result.record,
          })
        : null;
    return printAnswerResult(
      result,
      options.json === true,
      handlerResult,
      commandLabel,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    printAnswerError({
      commandLabel,
      json: options.json === true,
      error: "answer-failed",
      message: `${commandLabel}: failed: ${msg}`,
    });
    return 1;
  } finally {
    await runtime.close();
  }
}

function printAnswerResult(
  result: AnswerQuestionResult,
  json: boolean,
  handlerResult: AnswerHandlerDispatchResult,
  commandLabel: string,
): number {
  switch (result.kind) {
    case "not-found":
      printAnswerError({
        commandLabel,
        json,
        error: "question-not-found",
        message: `${commandLabel}: question was not found.`,
      });
      return 64;
    case "already-answered":
      if (json) {
        console.log(
          formatJson({
            schema: ANSWER_SCHEMA,
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
        console.log(formatAnswerOutcome({
          commandLabel,
          status: "already answered",
          record: result.record,
          suffix,
        }));
      }
      return 0;
    case "invalid-option":
      if (json) {
        console.log(
          formatJson({
            schema: ANSWER_SCHEMA,
            status: "invalid-option",
            options: result.options,
            question: recordToJson(result.record),
          }),
        );
      } else {
        printAnswerError({
          commandLabel,
          json,
          error: "invalid-option",
          message:
            `${commandLabel}: invalid answer. Expected one of: ${result.options.join(", ")}`,
        });
      }
      return 64;
    case "answered":
      if (json) {
        console.log(
          formatJson({
            schema: ANSWER_SCHEMA,
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
        console.log(formatAnswerOutcome({
          commandLabel,
          status: "answered",
          record: result.record,
          suffix,
        }));
      }
      return 0;
  }
}

function formatQuestion(commandLabel: string, record: QuestionRecord): string {
  const lines = [
    formatHeadline(
      titleForCommand(commandLabel),
      `question ${record.id} ${record.answeredAt === null ? "open" : "answered"}`,
    ),
  ];
  pushSection(lines, "Question", [`  ${record.effect.question}`]);
  const summary: Array<readonly [string, string]> = [
    ["answer", record.answer ?? "none"],
    ["options", record.effect.options?.join(", ") ?? "free-form"],
    ["asked", record.askedAt],
    ["processor", record.processorId],
  ];
  if (record.answeredAt !== null) summary.push(["answered", record.answeredAt]);
  pushSection(lines, "Details", formatSummaryRows(summary));
  if (record.effect.sourceRefs.length > 0) {
    pushSection(
      lines,
      "SourceRefs",
      record.effect.sourceRefs.map((ref) => `  - ${formatSourceRef(ref)}`),
    );
  }
  if (record.answeredAt === null) {
    pushSection(lines, "Next", [
      `  ${formatCommand(`${commandLabel} ${record.id} <value>`)}`,
    ]);
  }
  return lines.join("\n");
}

function formatAnswerOutcome(input: {
  readonly commandLabel: string;
  readonly status: "answered" | "already answered";
  readonly record: QuestionRecord;
  readonly suffix: string;
}): string {
  const lines = [
    formatHeadline(
      titleForCommand(input.commandLabel),
      `${input.status} question ${input.record.id}`,
    ),
  ];
  pushSection(lines, "Result", formatSummaryRows([
    ["answer", input.record.answer ?? "none"],
    [
      "handlers",
      input.suffix.length === 0
        ? "none"
        : input.suffix.replace(/^ \| /, ""),
    ],
  ]));
  return lines.join("\n");
}

function titleForCommand(commandLabel: string): string {
  return commandLabel
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatSourceRef(
  ref: QuestionRecord["effect"]["sourceRefs"][number],
): string {
  const range = ref.range === undefined
    ? ""
    : `:${ref.range.startLine}-${ref.range.endLine}`;
  return `${ref.path}${range} @ ${ref.commit.slice(0, 7)}`;
}

function printAnswerError(input: {
  readonly commandLabel: string;
  readonly json: boolean;
  readonly error: string;
  readonly message: string;
}): void {
  if (input.json) {
    console.log(formatJson({
      schema: ANSWER_SCHEMA,
      status: "error",
      error: input.error,
      message: input.message,
    }));
    return;
  }
  console.error(input.message);
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

function parseQuestionId(raw: string | number | undefined): number | null {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}
