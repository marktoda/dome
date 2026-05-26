import type { Vault } from "../vault";
import { WorkflowRegistry } from "../prompts/registry";
import { WorkflowTier, WORKFLOW_TIERS } from "../workflows/workflow-tier";
import { WorkflowName } from "../workflows/workflow-name";

export interface PromptAdapter {
  name: string;
  description: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  body: string;
}

const MCP_PROMPT_PREFIX = "dome.workflow.";

// MCP prompt naming: dome.workflow.<name> with hyphens -> underscores
function toMcpPromptName(name: WorkflowName): string {
  return `${MCP_PROMPT_PREFIX}${name.replace(/-/g, "_")}`;
}

export async function buildPromptAdapters(vault: Vault): Promise<PromptAdapter[]> {
  const reg = new WorkflowRegistry(vault);
  const all = await reg.list();
  // Include shipped-default unconditionally; include opt-in only when the vault
  // has a vault-local override (proxy: workflow loaded from vault-local source).
  const adapters: PromptAdapter[] = [];
  for (const def of all) {
    const tier = WORKFLOW_TIERS[def.name];
    const isShippedDefault = tier === WorkflowTier.ShippedDefault;
    const isOptInActivated = tier === WorkflowTier.OptIn && def.source === "vault-local";
    if (!isShippedDefault && !isOptInActivated) continue;
    // sensitivity-classify is a sub-workflow; substrate (mcp-surface.md I1 fix) explicitly excludes it
    if (def.name === WorkflowName.SensitivityClassify) continue;
    adapters.push({
      name: toMcpPromptName(def.name),
      description: def.frontmatter.description ?? `The ${def.name} workflow.`,
      body: def.body,
    });
  }
  return adapters;
}
