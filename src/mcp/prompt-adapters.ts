import type { Vault } from "../vault";
import { WorkflowRegistry } from "../prompts/registry";
import { PromptLoader } from "../prompts/prompt-loader";
import { WorkflowTier, WORKFLOW_TIERS } from "../workflows/workflow-tier";
import { WorkflowName } from "../workflows/workflow-name";

export interface PromptAdapter {
  name: string;
  description: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  body: string;
}

const MCP_PROMPT_PREFIX = "dome.workflow.";

// Top-level MCP prompt for the wiki-maintainer system prompt; harnesses load
// this at session start. Distinct from the workflow-prefixed prompts (which
// drive a single intake/lint/query run); this one is the always-on substrate.
export const MCP_SYSTEM_PROMPT_NAME = "dome.system_prompt";

// MCP prompt naming: dome.workflow.<name> with hyphens -> underscores
function toMcpPromptName(name: WorkflowName): string {
  return `${MCP_PROMPT_PREFIX}${name.replace(/-/g, "_")}`;
}

export async function buildPromptAdapters(vault: Vault): Promise<PromptAdapter[]> {
  const adapters: PromptAdapter[] = [];

  // Expose system-base.md as `dome.system_prompt` at the top of the list so
  // harnesses can fetch the wiki-maintainer prompt directly via the MCP
  // prompts capability. (mcp-surface I1/I2: system_prompt as a first-class
  // MCP prompt.)
  const loader = new PromptLoader(vault);
  const systemBase = await loader.load("system-base");
  if (systemBase) {
    adapters.push({
      name: MCP_SYSTEM_PROMPT_NAME,
      description: "Wiki-maintainer system prompt; harnesses load at session start.",
      body: systemBase.body,
    });
  }

  const reg = new WorkflowRegistry(vault);
  const all = await reg.list();
  // Include shipped-default unconditionally; include opt-in only when the vault
  // has a vault-local override (proxy: workflow loaded from vault-local source).
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
