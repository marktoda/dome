import { existsSync } from "node:fs";
import { join } from "node:path";
import git from "isomorphic-git";
import fs from "node:fs";
import { openVault } from "../../vault";
import { AgentLoop, type LlmClient } from "../../workflows/agent-loop";
import { WorkflowName } from "../../workflows/workflow-name";
import { ok, err, type Result, type ToolError } from "../../types";

export async function domeMigrate(
  vaultPath: string,
  apply: boolean,
  client: LlmClient,
): Promise<Result<{ turns: number }, ToolError>> {
  // Ensure .git exists (per VAULT_IS_GIT_REPO axiom).
  if (!existsSync(join(vaultPath, ".git"))) {
    await git.init({ fs, dir: vaultPath, defaultBranch: "main" });
  }
  // Real migration plan-generation runs in the workflow via the LLM. The CLI
  // shim only ensures the vault is openable; bootstrapping .dome/ for an
  // existing markdown directory is the workflow's job.
  const res = await openVault(vaultPath);
  if (!res.ok) return res;
  const loop = new AgentLoop(res.value, client);
  try {
    const r = await loop.runWorkflow(WorkflowName.Migrate, apply ? "--apply" : undefined);
    return ok({ turns: r.turns });
  } catch (e: unknown) {
    return err({ kind: "validation", message: (e as Error).message });
  }
}
