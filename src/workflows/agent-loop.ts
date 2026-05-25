import type { Vault } from "../vault";
import { WorkflowRegistry } from "../prompts/registry";
import type { WorkflowName } from "./workflow-name";

export type LlmTurn =
  | { kind: "continue" }
  | { kind: "stop"; reason: string };

export interface LlmClient {
  next(input: {
    systemPrompt: string;
    toolNames: ReadonlyArray<string>;
    userMessage?: string;
  }): Promise<LlmTurn>;
}

export const AGENT_LOOP_MAX_TURNS = 50;

export class AgentLoop {
  private registry: WorkflowRegistry;

  constructor(vault: Vault, private client: LlmClient) {
    this.registry = new WorkflowRegistry(vault);
  }

  async runWorkflow(
    name: WorkflowName,
    userMessage?: string
  ): Promise<{ turns: number; reason: string }> {
    const wf = await this.registry.get(name);
    if (!wf) throw new Error(`workflow not found: ${name}`);
    const systemPrompt = wf.body;
    const toolNames: ReadonlyArray<string> = wf.frontmatter.tools;

    let turns = 0;
    while (turns < AGENT_LOOP_MAX_TURNS) {
      turns++;
      // exactOptionalPropertyTypes-friendly: only include userMessage if defined.
      const input: { systemPrompt: string; toolNames: ReadonlyArray<string>; userMessage?: string } = {
        systemPrompt,
        toolNames,
        ...(userMessage !== undefined ? { userMessage } : {}),
      };
      const turn = await this.client.next(input);
      if (turn.kind === "stop") {
        return { turns, reason: turn.reason };
      }
    }
    return { turns, reason: "max-turns-reached" };
  }
}
