// `--show workflows`: list known workflow names with whether each is present.
//
// "Known" comes from the WORKFLOW_NAMES enum (canonical surface for the
// shipped prompts); "present" is whatever the vault's WorkflowRegistry
// actually finds on disk. Missing names get a `(missing)` suffix.

import type { Vault } from "../../../vault";
import { WorkflowRegistry } from "../../../prompts/registry";
import { WORKFLOW_NAMES } from "../../../workflows/workflow-name";

export async function showWorkflows(vault: Vault): Promise<{ info: string[] }> {
  const info: string[] = [];

  const reg = new WorkflowRegistry(vault);
  const defs = await reg.list();
  const present = new Set(defs.map(d => d.name));
  for (const name of WORKFLOW_NAMES) {
    info.push(`workflow: ${name}${present.has(name) ? "" : " (missing)"}`);
  }

  return { info };
}
