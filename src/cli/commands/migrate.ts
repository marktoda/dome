import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { initRepo } from "../../git";
import { scaffoldVaultLayout } from "../../vault-scaffold";
import { WorkflowName } from "../../workflows/workflow-name";
import type { RunWorkflowOpts } from "../../workflows/agent-loop";
import { runWorkflowAtPath } from "../run-workflow-at-path";
import { checkAnthropicApiKey } from "../api-key-guard";
import type { CliError } from "../cli-error";
import { err, type Result } from "../../types";

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
): Promise<Result<{ steps: number; text: string }, CliError>> {
  // ANTHROPIC_API_KEY pre-flight runs FIRST (unless a mock model was passed).
  // Migrate's own pre-flights (scaffold, git init) are pointless if we can't
  // run the workflow that consumes them — bail before touching disk.
  if (typeof opts.model !== "object") {
    const keyErr = checkAnthropicApiKey();
    if (keyErr) return err(keyErr);
  }
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
  return runWorkflowAtPath(vaultPath, WorkflowName.Migrate, apply ? "--apply" : "", opts);
}
