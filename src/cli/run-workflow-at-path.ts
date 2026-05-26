// Shared CLI primitive: API-key pre-flight -> openVault -> runWorkflow.
//
// The three workflow-driven CLI commands (lint, migrate, export-context)
// all share this exact shape, differing only in (a) the workflow name to
// dispatch and (b) the user-message payload. Each used to inline the
// pre-flight + open + dispatch trio, with the only meaningful difference
// being which `WorkflowName` they passed. Lifting to one helper means a
// future fourth workflow-driven command (or a non-CLI shell that wants
// the same shape) gets the behavior for free.

import { openVault } from "../vault";
import { runWorkflow, type RunWorkflowOpts } from "../workflows/agent-loop";
import type { WorkflowName } from "../workflows/workflow-name";
import { checkAnthropicApiKey } from "./api-key-guard";
import type { CliError } from "./cli-error";
import { ok, err, type Result } from "../types";

/**
 * Open the vault at `vaultPath`, dispatch the named workflow with
 * `userMessage`, and return the workflow's `{ steps, text }` summary.
 *
 * The pre-flight skips the ANTHROPIC_API_KEY check when the caller has
 * supplied a custom model (tests typically pass `MockLanguageModelV3`
 * via `opts.model` and don't need a real key).
 *
 * The CLI's three workflow-driven commands (`dome lint`, `dome migrate`,
 * `dome export-context`) all reduce to a single call to this function;
 * migrate adds its own scaffold-and-git-init pre-flight before calling.
 */
export async function runWorkflowAtPath(
  vaultPath: string,
  workflowName: WorkflowName,
  userMessage: string,
  opts: RunWorkflowOpts = {},
): Promise<Result<{ steps: number; text: string }, CliError>> {
  if (typeof opts.model !== "object") {
    const keyErr = checkAnthropicApiKey();
    if (keyErr) return err(keyErr);
  }
  const res = await openVault(vaultPath);
  if (!res.ok) return res;
  try {
    const r = await runWorkflow(res.value, workflowName, userMessage, opts);
    return ok({ steps: r.steps, text: r.text });
  } catch (e: unknown) {
    return err({ kind: "validation", message: (e as Error).message });
  }
}
