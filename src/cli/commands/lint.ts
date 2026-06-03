// cli/commands/lint: first-class wrapper for the dome.lint report view.

import { formatJson } from "../format";
import { parsePositiveIntegerValue } from "../parse-options";
import {
  firstPartyViewNotFoundMessage,
  printViewCommandMessages,
  runStructuredViewCommand,
  structuredViewBrokerMessages,
} from "./view-shared";

export type LintFailOn = "info" | "warning" | "error" | "block" | "never";

export type LintCommandOptions = {
  readonly failOn?: LintFailOn | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
  readonly limit?: string | number | boolean | undefined;
};

export async function runLint(
  options: LintCommandOptions = {},
): Promise<number> {
  try {
    const limit = parsePositiveIntegerValue(options.limit, null);
    if (options.limit !== undefined && limit === null) {
      console.error("dome lint: --limit must be a positive integer.");
      return 64;
    }

    const run = await runStructuredViewCommand({
      commandLabel: "dome lint",
      commandName: "lint",
      expectedViewName: "dome.lint.report",
      expectedSchema: "dome.lint.report/v1",
      commandArgs: Object.freeze({
        ...(options.failOn !== undefined ? { failOn: options.failOn } : {}),
        ...(limit !== null ? { limit } : {}),
      }),
      vault: options.vault,
      bundlesRoot: options.bundlesRoot,
      notFoundMessage: firstPartyViewNotFoundMessage({
        commandLabel: "dome lint",
        bundleId: "dome.lint",
        processorName: "lint",
      }),
      noStructuredResultMessage:
        "dome lint: lint processor returned no structured result.",
    });

    if (run.kind === "error") {
      printViewCommandMessages(run.messages);
      return run.exitCode;
    }
    printViewCommandMessages(
      structuredViewBrokerMessages("dome lint", run.brokerDiagnostics),
    );

    const data = parseLintData(run.data);
    if (options.json === true) {
      console.log(formatJson(run.data));
    } else {
      console.log(data.markdown);
    }
    return data.status === "fail" ? 1 : 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (options.json === true) {
      console.log(
        formatJson({ status: "error", error: "lint-failed", message: msg }),
      );
    } else {
      console.error(`dome lint: failed: ${msg}`);
    }
    return 1;
  }
}

function parseLintData(data: unknown): {
  readonly status: "pass" | "fail";
  readonly markdown: string;
} {
  if (data === null || typeof data !== "object") {
    throw new Error("lint structured data must be an object.");
  }
  const record = data as Record<string, unknown>;
  if (record.status !== "pass" && record.status !== "fail") {
    throw new Error("lint structured data status must be 'pass' or 'fail'.");
  }
  if (typeof record.markdown !== "string") {
    throw new Error("lint structured data markdown must be a string.");
  }
  const status = record.status;
  const markdown = record.markdown;
  return Object.freeze({ status, markdown });
}
