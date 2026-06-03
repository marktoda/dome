// cli/commands/export-context: source-backed markdown packets for handoff.

import { formatJson } from "../format";
import {
  firstPartyViewNotFoundMessage,
  printViewCommandError,
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
      notFoundMessage: firstPartyViewNotFoundMessage({
        commandLabel: "dome export-context",
        bundleId: "dome.search",
        processorName: "export-context",
      }),
      noStructuredResultMessage:
        "dome export-context: processor returned no structured result.",
    });

    if (run.kind === "error") {
      printViewCommandError({
        commandLabel: "dome export-context",
        json: options.json === true,
        messages: run.messages,
      });
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
    printViewCommandError({
      commandLabel: "dome export-context",
      json: options.json === true,
      error: "export-context-failed",
      messages: [`dome export-context: failed: ${msg}`],
    });
    return 1;
  }
}

function markdownFromData(data: unknown): string {
  if (data === null || typeof data !== "object") {
    throw new Error("export-context structured data must be an object.");
  }
  const record = data as Record<string, unknown>;
  const markdown = record.markdown;
  if (typeof markdown !== "string") {
    throw new Error("export-context structured data markdown must be a string.");
  }
  return markdown;
}
