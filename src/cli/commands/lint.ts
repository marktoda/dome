import { WorkflowName } from "../../workflows/workflow-name";
import type { RunWorkflowOpts } from "../../workflows/agent-loop";
import { runWorkflowAtPath } from "../run-workflow-at-path";
import { isDirtyGitState } from "../../reconcile";
import { err, type Result } from "../../types";
import type { CliError } from "../cli-error";

/**
 * Run the lint workflow against the vault.
 *
 * Two modes per wiki/specs/cli.md §"dome lint":
 *
 * - Propose mode (default): `applyIds` is undefined or empty. The workflow
 *   walks the vault and writes a structured report under
 *   inbox/review/lint-report-YYYY-MM-DD.md (when sensitivity routing is
 *   enabled) or returns the report inline.
 * - Apply mode (`applyIds` is a non-empty array): re-invokes the workflow
 *   with the user message `apply <id1> <id2> ...`. The workflow (per
 *   src/prompts/builtin/lint.md §"Apply mode") locates the most recent
 *   report, finds each finding by id, and executes the recommendation via
 *   writeDocument/moveDocument/deleteDocument — every mutation auto-logged
 *   per EVERY_WRITE_IS_LOGGED.
 *
 * Apply mode refuses to run if the vault is mid-merge/rebase/cherry-pick
 * (same guard as `dome reconcile` per wiki/gotchas/dirty-git-state-at-reconcile).
 * Empty ids are a CLI usage error — surfaced before any workflow dispatch.
 */
export async function domeLint(
  vaultPath: string,
  opts: RunWorkflowOpts = {},
  applyIds?: ReadonlyArray<string>,
): Promise<Result<{ steps: number; text: string }, CliError>> {
  const isApplyMode = applyIds !== undefined && applyIds.length > 0;

  if (isApplyMode) {
    for (const id of applyIds!) {
      if (id.length === 0) {
        return err({
          kind: "validation",
          message: "lint --apply requires a non-empty finding id (got empty string)",
        });
      }
    }
    if (isDirtyGitState(vaultPath)) {
      return err({
        kind: "validation",
        message:
          "Vault is in a dirty git state (mid-merge/rebase/cherry-pick). Resolve before applying lint findings.",
      });
    }
  }

  const userMessage = isApplyMode ? `apply ${applyIds!.join(" ")}` : "";
  return runWorkflowAtPath(vaultPath, WorkflowName.Lint, userMessage, opts);
}
