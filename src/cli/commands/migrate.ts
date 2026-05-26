import { existsSync } from "node:fs";
import { join } from "node:path";
import { initRepo } from "../../git";
import { openVault } from "../../vault";
import { runWorkflow, type RunWorkflowOpts } from "../../workflows/agent-loop";
import { WorkflowName } from "../../workflows/workflow-name";
import { ok, err, type Result, type ToolError } from "../../types";

export async function domeMigrate(
  vaultPath: string,
  apply: boolean,
  opts: RunWorkflowOpts = {},
): Promise<Result<{ steps: number; text: string }, ToolError>> {
  // The target must already exist on disk; migrate operates on existing
  // markdown directories, not on bare paths. Bail with a Result error so the
  // CLI surfaces Failure rather than throwing.
  if (!existsSync(vaultPath)) {
    return err({ kind: "validation", message: `migrate: path does not exist: ${vaultPath}` });
  }
  // Ensure .git exists (per VAULT_IS_GIT_REPO axiom).
  if (!existsSync(join(vaultPath, ".git"))) {
    try {
      await initRepo(vaultPath);
    } catch (e: unknown) {
      return err({ kind: "validation", message: (e as Error).message });
    }
  }
  // Real migration plan-generation runs in the workflow via the LLM. The CLI
  // shim only ensures the vault is openable; bootstrapping .dome/ for an
  // existing markdown directory is the workflow's job.
  const res = await openVault(vaultPath);
  if (!res.ok) return res;
  try {
    const r = await runWorkflow(res.value, WorkflowName.Migrate, apply ? "--apply" : "", opts);
    return ok({ steps: r.steps, text: r.text });
  } catch (e: unknown) {
    return err({ kind: "validation", message: (e as Error).message });
  }
}
