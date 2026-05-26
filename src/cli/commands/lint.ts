import { openVault } from "../../vault";
import { AgentLoop, type LlmClient } from "../../workflows/agent-loop";
import { WorkflowName } from "../../workflows/workflow-name";
import { ok, err, type Result, type ToolError } from "../../types";

export async function domeLint(vaultPath: string, client: LlmClient): Promise<Result<{ turns: number }, ToolError>> {
  const res = await openVault(vaultPath);
  if (!res.ok) return res;
  const loop = new AgentLoop(res.value, client);
  try {
    const r = await loop.runWorkflow(WorkflowName.Lint);
    return ok({ turns: r.turns });
  } catch (e: unknown) {
    return err({ kind: "validation", message: (e as Error).message });
  }
}
