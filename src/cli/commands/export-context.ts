// cli/commands/export-context: source-backed markdown packets for handoff.

import { FIRST_PARTY_VIEWS } from "../../surface/view-catalog";
import { printViewCommandError } from "./view-shared";
import { runCliStructuredView } from "../structured-view-command";

export type ExportContextCommandOptions = {
  readonly topic?: string | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
  readonly limit?: number | undefined;
};

export async function runExportContext(
  options: ExportContextCommandOptions = {},
): Promise<number> {
  const topic = options.topic?.trim() ?? "";
  if (topic.length === 0) {
    printViewCommandError({
      commandLabel: "dome export-context",
      json: options.json === true,
      error: "export-context-usage",
      messages: [
        "dome export-context: missing topic. Usage: dome export-context <topic>",
      ],
    });
    return 64;
  }

  return runCliStructuredView({
    commandLabel: "dome export-context",
    entry: FIRST_PARTY_VIEWS.exportContext,
    commandArgs: Object.freeze({
      topic,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    }),
    vault: options.vault,
    bundlesRoot: options.bundlesRoot,
    json: options.json === true,
    noStructuredResultMessage:
      "dome export-context: processor returned no structured result.",
    failedError: "export-context-failed",
    renderHuman: (data) => data.markdown,
  });
}
