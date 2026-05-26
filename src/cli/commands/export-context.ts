import { openVault } from "../../vault";
import { runWorkflow, type RunWorkflowOpts } from "../../workflows/agent-loop";
import { WorkflowName } from "../../workflows/workflow-name";
import { ok, err, type Result, type ToolError } from "../../types";

export async function domeExportContext(
  vaultPath: string,
  topic: string,
  opts: RunWorkflowOpts = {},
): Promise<Result<{ steps: number }, ToolError>> {
  const res = await openVault(vaultPath);
  if (!res.ok) return res;
  try {
    const r = await runWorkflow(res.value, WorkflowName.ExportContext, topic, opts);
    return ok({ steps: r.steps });
  } catch (e: unknown) {
    return err({ kind: "validation", message: (e as Error).message });
  }
}
