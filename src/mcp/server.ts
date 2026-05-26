import type { Vault } from "../vault";
import { buildToolAdapters, type ToolAdapter } from "./tool-adapters";
import { buildPromptAdapters, type PromptAdapter } from "./prompt-adapters";
import { ResourceAdapter } from "./resource-adapters";

export interface DomeMcpServerOpts {
  vault: Vault;
}

export class DomeMcpServer {
  readonly tools: ToolAdapter[];
  readonly resources: ResourceAdapter;
  private _prompts: PromptAdapter[] | null = null;

  constructor(private opts: DomeMcpServerOpts) {
    this.tools = buildToolAdapters(opts.vault);
    this.resources = new ResourceAdapter(opts.vault);
  }

  async prompts(): Promise<PromptAdapter[]> {
    if (this._prompts) return this._prompts;
    this._prompts = await buildPromptAdapters(this.opts.vault);
    return this._prompts;
  }

  async serveStdio(): Promise<void> {
    // Wire @modelcontextprotocol/sdk Server in stdio transport. v0.5 minimal wiring.
    // The full wire integration (Zod -> JSON schema derivation, tool/prompt/resource
    // dispatch handlers) lands when the first harness consumes this entry point.
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const server = new Server(
      { name: "@dome/sdk", version: "0.0.1" },
      { capabilities: { tools: {}, prompts: {}, resources: {} } }
    );
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}
