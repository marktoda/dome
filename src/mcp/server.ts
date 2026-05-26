import type { Vault } from "../vault";
import { buildToolAdapters, type ToolAdapter } from "./tool-adapters";
import { buildPromptAdapters, type PromptAdapter } from "./prompt-adapters";
import { ResourceAdapter } from "./resource-adapters";
import { registerHandlers, type ServerLike } from "./handlers";
import { buildInstructions } from "./instructions-builder";

export interface DomeMcpServerOpts {
  vault: Vault;
}

export class DomeMcpServer {
  readonly tools: ToolAdapter[];
  readonly resources: ResourceAdapter;
  private _prompts: PromptAdapter[] | null = null;
  private _instructions: string | null = null;

  constructor(private opts: DomeMcpServerOpts) {
    this.tools = buildToolAdapters(opts.vault);
    this.resources = new ResourceAdapter(opts.vault);
  }

  async prompts(): Promise<PromptAdapter[]> {
    if (this._prompts) return this._prompts;
    this._prompts = await buildPromptAdapters(this.opts.vault);
    return this._prompts;
  }

  // Rich cold-start orientation for every connecting MCP client. Cached
  // because it's assembled once at server start and clients see it via
  // `initialize`; edits to AGENTS.md or .dome/config.yaml require a server
  // restart to take effect.
  async instructions(): Promise<string> {
    if (this._instructions !== null) return this._instructions;
    this._instructions = await buildInstructions(this.opts.vault);
    return this._instructions;
  }

  // Register all 6 request handlers on the given Server-like object. Exposed
  // separately so tests can drive it against a stub Server without spinning
  // up the stdio transport. Called by `serveStdio`.
  async registerOn(server: ServerLike): Promise<void> {
    const prompts = await this.prompts();
    registerHandlers(server, { tools: this.tools, prompts, resources: this.resources });
  }

  async serveStdio(): Promise<void> {
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const instructions = await this.instructions();
    const server = new Server(
      { name: "@dome/sdk", version: "0.0.1" },
      { capabilities: { tools: {}, prompts: {}, resources: {} }, instructions }
    );
    await this.registerOn(server as unknown as ServerLike);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}
