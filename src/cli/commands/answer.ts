// cli/commands/answer: resolve a durable QuestionEffect row.
//
// This is the small write-side companion behind `dome resolve` and the
// compatibility `dome answer` command.
// It owns CLI parsing/printing only; the projection accessor owns row
// lookup, multiple-choice validation, and mutation semantics.

import { basename } from "node:path";

import type { AnswerHandlerDispatchResult } from "../../engine/host/question-answering";
import type { QuestionRecord } from "../../projections/questions";
import type { ResolveOutcome } from "../../vault";
import { withVaultCli } from "../vault-helpers";

import { formatJson } from "../../surface/format";
import { formatCommand } from "../human-output";
import {
  bullets,
  footer,
  headline,
  kv,
  resolveCaps,
  section,
} from "../presenter";

import {
  openVaultFailureInfo,
  vaultOpenFailureMessage,
} from "../../surface/adapter";
import { resolveVaultPath } from "../../surface/resolve-vault";
import {
  ANSWER_SCHEMA,
  answerHandlersJson,
  questionRecordJson,
} from "../../surface/answer";

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

  const vaultPath = resolveVaultPath(options.vault);
  return withVaultCli({
    path: vaultPath,
    bundlesRoot: options.bundlesRoot,
    onOpenFailed: (error) => {
      const failure = openVaultFailureInfo(error);
      printAnswerError({
        commandLabel,
        json: options.json === true,
        error: failure.errorKind,
        message: vaultOpenFailureMessage(commandLabel, error),
      });
      return 1;
    },
    run: async (vault) => {
      try {
        const rawValue = options.value?.trim();
        if (rawValue === undefined || rawValue.length === 0) {
          const record = await vault.getQuestion(id);
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
              ...questionRecordJson(record),
            }));
          } else {
            console.log(formatQuestion(commandLabel, vaultPath, record));
          }
          return 0;
        }

        const outcome = await vault.resolve(id, rawValue);
        return printAnswerResult(
          outcome,
          options.json === true,
          commandLabel,
          vaultPath,
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
      }
    },
  });
}

function printAnswerResult(
  result: ResolveOutcome,
  json: boolean,
  commandLabel: string,
  vaultPath: string,
): number {
  const handlerResult =
    result.kind === "answered" || result.kind === "already-answered"
      ? result.handlers
      : null;
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
            question: questionRecordJson(result.record),
            handlers:
              handlerResult === null ? null : answerHandlersJson(handlerResult),
          }),
        );
      } else {
        const handlersSummary = formatHandlersSummary(handlerResult);
        console.log(formatAnswerOutcome({
          commandLabel,
          vaultPath,
          statusLabel: `already answered question ${result.record.id}`,
          record: result.record,
          handlersSummary,
          showActor: true,
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
            question: questionRecordJson(result.record),
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
            question: questionRecordJson(result.record),
            handlers:
              handlerResult === null ? null : answerHandlersJson(handlerResult),
          }),
        );
      } else {
        const handlersSummary = formatHandlersSummary(handlerResult);
        console.log(formatAnswerOutcome({
          commandLabel,
          vaultPath,
          statusLabel: `answered question ${result.record.id}`,
          record: result.record,
          handlersSummary,
        }));
      }
      return 0;
  }
}

function formatHandlersSummary(handlerResult: AnswerHandlerDispatchResult): string {
  if (handlerResult?.kind === "handled") return `${handlerResult.result.runs.length} run(s)`;
  if (handlerResult?.kind === "skipped") return `skipped (${handlerResult.reason})`;
  return "none";
}

function formatQuestion(
  commandLabel: string,
  vaultPath: string,
  record: QuestionRecord,
): string {
  const caps = resolveCaps();
  const cmd = commandLabel.split(/\s+/).pop() ?? commandLabel;
  const statusTone = record.answeredAt === null ? "warn" : "ok";
  const statusLabel = `question ${record.id} ${record.answeredAt === null ? "open" : "answered"}`;
  const lines: string[] = [
    headline({ cmd, context: basename(vaultPath) }, { tone: statusTone, label: statusLabel }, caps),
  ];
  lines.push(...section("Question", bullets([record.effect.question], caps), caps));

  const detailRows = buildDetailRows(record);
  lines.push(...section("Details", kv(detailRows, caps), caps));

  if (record.effect.sourceRefs.length > 0) {
    lines.push(
      ...section(
        "Source Refs",
        bullets(record.effect.sourceRefs.map((ref) => formatSourceRef(ref)), caps),
        caps,
      ),
    );
  }
  if (record.answeredAt === null) {
    lines.push(
      ...section(
        "Next",
        [`  ${formatCommand(`${commandLabel} ${record.id} <value>`)}`],
        caps,
      ),
    );
  }
  return lines.join("\n");
}

function buildDetailRows(record: QuestionRecord): Array<{ readonly label: string; readonly value: string }> {
  const rows: Array<{ label: string; value: string }> = [
    { label: "answer", value: record.answer ?? "none" },
    { label: "options", value: record.effect.options?.join(", ") ?? "free-form" },
    { label: "asked", value: record.askedAt },
    { label: "processor", value: record.processorId },
  ];
  if (record.answeredAt !== null) {
    rows.push({
      label: "answered",
      value: `${record.answeredAt} (answered by ${record.answeredBy ?? "owner"})`,
    });
  }
  return rows;
}

function formatAnswerOutcome(input: {
  readonly commandLabel: string;
  readonly vaultPath: string;
  readonly statusLabel: string;
  readonly record: QuestionRecord;
  readonly handlersSummary: string;
  readonly showActor?: boolean;
}): string {
  const caps = resolveCaps();
  const cmd = input.commandLabel.split(/\s+/).pop() ?? input.commandLabel;
  const lines: string[] = [
    headline(
      { cmd, context: basename(input.vaultPath) },
      { tone: "ok", label: input.statusLabel },
      caps,
    ),
  ];
  const resultRows: Array<{ readonly label: string; readonly value: string }> = [
    { label: "answer", value: input.record.answer ?? "none" },
  ];
  if (input.showActor === true) {
    resultRows.push({
      label: "actor",
      value: `answered by ${input.record.answeredBy ?? "owner"}`,
    });
  }
  resultRows.push({ label: "handlers", value: input.handlersSummary });
  lines.push(
    ...section(
      "Result",
      kv(resultRows, caps),
      caps,
    ),
  );
  lines.push(...footer({ tone: "ok", label: input.statusLabel }, caps));
  return lines.join("\n");
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

function parseQuestionId(raw: string | number | undefined): number | null {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}
