import type { Vault } from "../vault";
import { runWorkflow, type RunWorkflowOpts } from "../workflows/agent-loop";
import type { WorkflowName } from "../workflows/workflow-name";

export interface ExpectedEffects {
  wrotePaths?: ReadonlyArray<string>;
  movedFromTo?: ReadonlyArray<[string, string]>;
  logEntriesContaining?: ReadonlyArray<string>;
}

export interface ReplayCase {
  workflow: WorkflowName;
  userMessage: string;
  expected: ExpectedEffects;
}

export interface ReplayResult {
  passed: boolean;
  missing: ReadonlyArray<string>;
  extra: ReadonlyArray<string>;
}

/**
 * v0.5 replay scaffold: drives the workflow runner against a fixture vault.
 *
 * Full conversational replay (live LLM + recorded fixtures + effect diffing)
 * lands when the eval harness records SDK tool-call streams. For now, callers
 * use this as a smoke driver and assert effect shape via direct Tool calls.
 */
export async function replay(
  vault: Vault,
  kase: ReplayCase,
  opts: RunWorkflowOpts = {},
): Promise<ReplayResult> {
  await runWorkflow(vault, kase.workflow, kase.userMessage, opts);
  return { passed: true, missing: [], extra: [] };
}
