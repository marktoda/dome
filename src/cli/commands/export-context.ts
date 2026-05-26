import { openVault } from "../../vault";
import { runWorkflow, type RunWorkflowOpts } from "../../workflows/agent-loop";
import { WorkflowName } from "../../workflows/workflow-name";
import { checkAnthropicApiKey } from "../api-key-guard";
import type { CliError } from "../cli-error";
import { ok, err, type Result } from "../../types";

export async function domeExportContext(
  vaultPath: string,
  topic: string,
  opts: RunWorkflowOpts = {},
): Promise<Result<{ steps: number; text: string }, CliError>> {
  // Pre-flight ANTHROPIC_API_KEY check (unless caller passed a mock model).
  if (typeof opts.model !== "object") {
    const keyErr = checkAnthropicApiKey();
    if (keyErr) return err(keyErr);
  }
  const res = await openVault(vaultPath);
  if (!res.ok) return res;
  try {
    const r = await runWorkflow(res.value, WorkflowName.ExportContext, topic, opts);
    return ok({ steps: r.steps, text: r.text });
  } catch (e: unknown) {
    return err({ kind: "validation", message: (e as Error).message });
  }
}
