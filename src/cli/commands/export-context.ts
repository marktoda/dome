// cli/commands/export-context: source-backed markdown packets for handoff.

import { formatJson } from "../format";
import {
  printViewCommandMessages,
  runStructuredViewCommand,
  structuredViewBrokerMessages,
} from "./view-shared";

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
    console.error(
      "dome export-context: missing topic. Usage: dome export-context <topic>",
    );
    return 64;
  }

  try {
    const run = await runStructuredViewCommand({
      commandLabel: "dome export-context",
      commandName: "export-context",
      expectedViewName: "dome.search.export-context",
      expectedSchema: "dome.search.export-context/v1",
      commandArgs: Object.freeze({
        topic,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      }),
      vault: options.vault,
      bundlesRoot: options.bundlesRoot,
      notFoundMessage:
        "dome export-context: dome.search is not installed or no export-context processor is enabled.",
      noStructuredResultMessage:
        "dome export-context: processor returned no structured result.",
    });

    if (run.kind === "error") {
      printViewCommandMessages(run.messages);
      return run.exitCode;
    }
    printViewCommandMessages(
      structuredViewBrokerMessages("dome export-context", run.brokerDiagnostics),
    );

    if (options.json === true) {
      console.log(formatJson(run.data));
    } else {
      console.log(markdownFromData(run.data));
    }
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`dome export-context: failed: ${msg}`);
    return 1;
  }
}

function markdownFromData(data: unknown): string {
  const record = data !== null && typeof data === "object"
    ? data as Record<string, unknown>
    : {};
  const markdown = record.markdown;
  return typeof markdown === "string" ? markdown : "";
}
