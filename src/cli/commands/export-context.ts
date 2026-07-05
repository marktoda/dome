// cli/commands/export-context: source-backed markdown packets for handoff.

import { FIRST_PARTY_VIEWS } from "../../surface/view-catalog";
import { resolveVaultPath } from "../../surface/resolve-vault";
import { printMissOutcome, printViewCommandError } from "./view-shared";
import { runCliStructuredView } from "../structured-view-command";

export type ExportContextCommandOptions = {
  readonly topic?: string | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
  readonly limit?: number | undefined;
  /** `--miss [note]`: Commander's optional-value shape — see `reportMissFromCliFlag`. */
  readonly miss?: string | boolean | undefined;
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

  const exitCode = await runCliStructuredView({
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

  // After printing the packet: --miss records this topic as a retrieval
  // miss (see src/cli/commands/query.ts's identical wiring).
  await printMissOutcome({
    commandLabel: "dome export-context",
    vault: resolveVaultPath(options.vault),
    query: topic,
    flag: options.miss,
  });

  return exitCode;
}
