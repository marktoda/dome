import type { Vault } from "../vault";
import { PromptLoader, type LoadedPrompt } from "./prompt-loader";
import { WORKFLOW_NAMES, type WorkflowName } from "../workflows/workflow-name";
import type { WorkflowFrontmatter } from "./workflow-frontmatter";

export interface WorkflowDefinition {
  name: WorkflowName;
  frontmatter: WorkflowFrontmatter;
  body: string;
  source: LoadedPrompt["source"];
}

export class WorkflowRegistry {
  private loader: PromptLoader;

  constructor(vault: Vault) {
    this.loader = new PromptLoader(vault);
  }

  async list(): Promise<ReadonlyArray<WorkflowDefinition>> {
    const out: WorkflowDefinition[] = [];
    for (const name of WORKFLOW_NAMES) {
      const def = await this.get(name);
      if (def) out.push(def);
    }
    return out;
  }

  async get(name: WorkflowName): Promise<WorkflowDefinition | null> {
    const prompt = await this.loader.load(name);
    if (!prompt || !prompt.workflow) return null;
    return {
      name,
      frontmatter: prompt.workflow,
      body: prompt.body,
      source: prompt.source,
    };
  }
}
