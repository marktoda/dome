// cli/commands/agent-work: direct-harness adapter for derived Agent Work.

import { formatJson } from "../../surface/format";
import { resolveVaultPath } from "../../surface/resolve-vault";
import { openVaultErrorKind } from "../../surface/adapter";
import { answerHandlersJson, questionRecordJson } from "../../surface/answer";
import { withVaultCli } from "../vault-helpers";

export type RunAgentWorkOptions = {
  readonly id?: string | number | undefined;
  readonly answer?: string | undefined;
  readonly revision?: string | undefined;
  readonly reason?: string | undefined;
  readonly evidence?: ReadonlyArray<string> | undefined;
  readonly limit?: number | undefined;
  readonly json?: boolean | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
};

export async function runAgentWork(
  options: RunAgentWorkOptions = {},
): Promise<number> {
  const id = parseOptionalId(options.id);
  if (id === "invalid") {
    return usage(options.json === true, "question id must be a positive integer");
  }
  const completing = options.answer !== undefined ||
    options.revision !== undefined || options.reason !== undefined ||
    (options.evidence?.length ?? 0) > 0;
  if (completing && id === undefined) {
    return usage(options.json === true, "completion requires a question id");
  }
  if (
    completing &&
    (
      options.answer?.trim().length === 0 ||
      options.revision?.trim().length === 0 ||
      options.reason?.trim().length === 0 ||
      (options.evidence?.length ?? 0) === 0 ||
      options.answer === undefined || options.revision === undefined ||
      options.reason === undefined
    )
  ) {
    return usage(
      options.json === true,
      "completion requires answer, --revision, --reason, and at least one --evidence path",
    );
  }

  return withVaultCli({
    path: resolveVaultPath(options.vault),
    bundlesRoot: options.bundlesRoot,
    onOpenFailed: (error) => {
      const message = `dome agent-work: vault open failed (${openVaultErrorKind(error)}).`;
      printError(options.json === true, "vault-open-failed", message);
      return error.kind === "not-a-vault" ? 64 : 1;
    },
    run: async (vault) => {
      const snapshot = await vault.agentWork({
        ...(id !== undefined ? { questionId: id } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
      if (!completing) {
        if (options.json === true) console.log(formatJson(snapshot));
        else printSnapshot(snapshot);
        return 0;
      }
      const item = snapshot.items[0];
      if (item === undefined) {
        printError(options.json === true, "not-found", `agent work ${id} was not found`);
        return 64;
      }
      const evidencePaths = new Set(options.evidence);
      const outcome = await vault.completeAgentWork({
        questionId: item.questionId,
        expectedRevision: options.revision!.trim(),
        answer: options.answer!.trim(),
        reason: options.reason!.trim(),
        evidence: item.sourceRefs.filter((ref) => evidencePaths.has(ref.path)),
      });
      if (outcome.kind === "not-found") {
        printError(options.json === true, "not-found", `agent work ${id} was not found`);
        return 64;
      }
      if (outcome.kind === "rejected") {
        printError(options.json === true, outcome.problem, outcome.message);
        return 64;
      }
      const document = {
        schema: "dome.agent-work-completion/v1",
        status: outcome.kind,
        question: questionRecordJson(outcome.record),
        handlers: outcome.handlers === null
          ? null
          : answerHandlersJson(outcome.handlers),
      };
      if (options.json === true) console.log(formatJson(document));
      else console.log(`completed agent work ${item.questionId}: ${outcome.record.answer}`);
      return 0;
    },
  });
}

function printSnapshot(snapshot: Awaited<ReturnType<import("../../vault").Vault["agentWork"]>>): void {
  if (snapshot.items.length === 0) {
    console.log("dome agent-work: no open agent work.");
    return;
  }
  console.log(snapshot.items.map((item) => [
    `${item.questionId}\t${item.readiness}\t${item.question}`,
    `  revision: ${item.revision}`,
    `  options: ${item.options.length === 0 ? "free-form" : item.options.join(" | ")}`,
    `  evidence: ${item.requiredEvidencePaths.join(", ") || "none"}`,
    `  why: ${item.readinessReason}`,
  ].join("\n")).join("\n"));
}

function parseOptionalId(value: string | number | undefined): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : "invalid";
}

function usage(json: boolean, message: string): number {
  printError(json, "agent-work-usage", `dome agent-work: ${message}`);
  return 64;
}

function printError(json: boolean, error: string, message: string): void {
  if (json) {
    console.log(formatJson({
      schema: "dome.agent-work-completion/v1",
      status: "error",
      error,
      message,
    }));
  } else {
    console.error(message);
  }
}
