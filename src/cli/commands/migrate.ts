import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { initRepo } from "../../git";
import { openVault } from "../../vault";
import { scaffoldVaultLayout } from "../../vault-scaffold";
import { runWorkflow, type RunWorkflowOpts } from "../../workflows/agent-loop";
import { WorkflowName } from "../../workflows/workflow-name";
import { ok, err, type Result, type ToolError } from "../../types";

/**
 * Bootstrap an existing markdown directory into Dome shape and run the
 * `migrate` workflow against it. The pre-flight is necessary because
 * `openVault` requires `.dome/config.yaml`; a directory that just has user
 * markdown won't open until we scaffold the config. scaffoldVaultLayout is
 * idempotent: if the directory is already a Dome vault, this is a no-op.
 */
export async function domeMigrate(
  vaultPath: string,
  apply: boolean,
  opts: RunWorkflowOpts = {},
): Promise<Result<{ steps: number; text: string }, ToolError>> {
  // The target must already exist on disk; migrate operates on existing
  // markdown directories, not on bare paths.
  if (!existsSync(vaultPath)) {
    return err({ kind: "validation", message: `migrate: path does not exist: ${vaultPath}` });
  }
  let st;
  try {
    st = await stat(vaultPath);
  } catch (e: unknown) {
    return err({ kind: "validation", message: (e as Error).message });
  }
  if (!st.isDirectory()) {
    return err({ kind: "validation", message: `migrate: ${vaultPath} is not a directory` });
  }
  // Ensure .git exists (per VAULT_IS_GIT_REPO axiom). isomorphic-git's init
  // is idempotent: re-running on an already-initialized repo is safe.
  if (!existsSync(`${vaultPath}/.git`)) {
    try {
      await initRepo(vaultPath);
    } catch (e: unknown) {
      return err({ kind: "validation", message: (e as Error).message });
    }
  }
  // Scaffold .dome/ + index.md + log.md if absent. This is what `openVault`
  // needs; the migrate workflow's job is to RESHAPE the user's existing
  // markdown content (moves, frontmatter, wikilink normalization), not to
  // bootstrap the .dome/ surface. Without this pre-flight, openVault errors
  // and the workflow never gets a chance to run.
  try {
    await scaffoldVaultLayout(vaultPath);
  } catch (e: unknown) {
    return err({ kind: "validation", message: (e as Error).message });
  }
  const res = await openVault(vaultPath);
  if (!res.ok) return res;
  try {
    const r = await runWorkflow(res.value, WorkflowName.Migrate, apply ? "--apply" : "", opts);
    return ok({ steps: r.steps, text: r.text });
  } catch (e: unknown) {
    return err({ kind: "validation", message: (e as Error).message });
  }
}
