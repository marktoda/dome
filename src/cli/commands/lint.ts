import { WorkflowName } from "../../workflows/workflow-name";
import type { RunWorkflowOpts } from "../../workflows/agent-loop";
import { runWorkflowAtPath } from "../run-workflow-at-path";
import type { CliError } from "../cli-error";
import type { Result } from "../../types";

export async function domeLint(
  vaultPath: string,
  opts: RunWorkflowOpts = {},
): Promise<Result<{ steps: number; text: string }, CliError>> {
  return runWorkflowAtPath(vaultPath, WorkflowName.Lint, "", opts);
}
