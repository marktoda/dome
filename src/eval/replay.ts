import type { Vault } from "../vault";
import type { AgentLoop } from "../workflows/agent-loop";
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
 * v0.5 replay scaffold: drives the AgentLoop against a fixture vault.
 *
 * Full conversational replay (live LLM + recorded fixtures + effect diffing)
 * lands when the Anthropic adapter exposes Tool metadata. For now, callers
 * use this as a smoke driver and assert effect shape via direct Tool calls.
 */
export async function replay(
  loop: AgentLoop,
  _vault: Vault,
  kase: ReplayCase
): Promise<ReplayResult> {
  await loop.runWorkflow(kase.workflow, kase.userMessage);
  return { passed: true, missing: [], extra: [] };
}
