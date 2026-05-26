import { openVault } from "../../vault";
import { runWorkflow, type RunWorkflowOpts } from "../../workflows/agent-loop";
import { WorkflowName } from "../../workflows/workflow-name";
import { ok, err, type Result, type ToolError } from "../../types";

export async function domeLint(
  vaultPath: string,
  opts: RunWorkflowOpts = {},
): Promise<Result<{ steps: number; text: string }, ToolError>> {
  const res = await openVault(vaultPath);
  if (!res.ok) return res;
  try {
    const r = await runWorkflow(res.value, WorkflowName.Lint, "", opts);
    return ok({ steps: r.steps, text: r.text });
  } catch (e: unknown) {
    return err({ kind: "validation", message: (e as Error).message });
  }
}
