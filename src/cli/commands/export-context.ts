// cli/commands/export-context: source-backed markdown packets for handoff.

import { formatJson } from "../format";
import { runSharedViewCommand } from "./view-shared";

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
    const run = await runSharedViewCommand({
      commandLabel: "dome export-context",
      commandName: "export-context",
      commandArgs: Object.freeze({
        topic,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      }),
      vault: options.vault,
      bundlesRoot: options.bundlesRoot,
    });

    if (run.kind === "usage-error") {
      console.error(run.message);
      return 64;
    }
    if (run.kind === "runtime-error") {
      console.error(run.message);
      return 1;
    }

    const result = run.result;
    if (result.kind === "not-found") {
      console.error(
        "dome export-context: dome.search is not installed or no export-context processor is enabled.",
      );
      return 64;
    }
    if (result.kind === "failed") {
      console.error(
        `dome export-context: processor '${result.processorId}' finished with ${result.executionStatus}.`,
      );
      if (result.executionError !== undefined) {
        console.error(
          `dome export-context: ${result.executionError.code}: ${result.executionError.message}`,
        );
      }
      for (const d of [...result.diagnostics, ...result.brokerDiagnostics]) {
        console.error(
          `dome export-context: diagnostic [${d.severity}] ${d.code}: ${d.message}`,
        );
      }
      return 1;
    }

    for (const d of result.brokerDiagnostics) {
      console.error(
        `dome export-context: broker diagnostic [${d.severity}] ${d.code}: ${d.message}`,
      );
    }

    const view = run.capturedViews[0] ?? result.effects[0];
    if (view === undefined || view.content.kind !== "structured") {
      console.error(
        "dome export-context: processor returned no structured result.",
      );
      return 1;
    }

    if (options.json === true) {
      console.log(formatJson(view.content.data));
    } else {
      console.log(markdownFromData(view.content.data));
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
