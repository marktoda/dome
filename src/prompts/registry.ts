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

  /**
   * Construct a WorkflowRegistry. When `loader` is omitted, the registry
   * builds its own PromptLoader (backward-compatible). When passed, the
   * registry reuses the caller's loader — `buildAbstractSurface` threads
   * its already-constructed loader through here so the `.dome/prompts/`
   * filesystem scan happens once per surface build, not twice. See the
   * F4 prompt-walk cascade in
   * docs/cohesive/plans/2026-05-26-dome-v0.5-to-v1-tightening.md.
   */
  constructor(vault: Vault, loader?: PromptLoader) {
    this.loader = loader ?? new PromptLoader(vault);
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
