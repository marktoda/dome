import type { RunWorkflowOpts } from "../../workflows/agent-loop";
import { runWorkflowAtPath } from "../run-workflow-at-path";
import type { CliError } from "../cli-error";
import type { Result } from "../../types";

export async function domeExportContext(
  vaultPath: string,
  topic: string,
  opts: RunWorkflowOpts = {},
): Promise<Result<{ steps: number; text: string }, CliError>> {
  return runWorkflowAtPath(vaultPath, "export-context", topic, opts);
}
