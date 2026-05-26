// DomeMcpServer — thin protocol adapter over ConsumerSurface.
//
// The server takes `{ surface }` only — the four kinds (tools, prompts,
// resources, instructions) are everything the protocol handlers need.
// `surface.tools` is the MCP-rendered ToolAdapter[] built by
// buildConsumerSurface; `surface.prompts` and `surface.resources` likewise.
// The constructor does no Vault-touching work — that's the substrate
// commitment in docs/wiki/specs/mcp-surface.md §"Construction".

import type { McpSurface, ToolAdapter } from "./render-mcp";
import { registerHandlers, type ServerLike } from "./handlers";

export interface DomeMcpServerOpts {
  /** The MCP-rendered four-kind surface per docs/wiki/specs/sdk-surface.md §"Consumer surfaces". */
  surface: McpSurface;
}

export class DomeMcpServer {
  readonly tools: ReadonlyArray<ToolAdapter>;

  constructor(private opts: DomeMcpServerOpts) {
    this.tools = opts.surface.tools;
  }

  // Register all 6 request handlers on the given Server-like object. Exposed
  // separately so tests can drive it against a stub Server without spinning
  // up the stdio transport. Called by `serveStdio`.
  registerOn(server: ServerLike): void {
    registerHandlers(server, {
      tools: [...this.tools],
      prompts: [...this.opts.surface.prompts],
      resources: this.opts.surface.resources,
    });
  }

  async serveStdio(): Promise<void> {
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const server = new Server(
      { name: "@dome/sdk", version: "0.0.1" },
      { capabilities: { tools: {}, prompts: {}, resources: {} }, instructions: this.opts.surface.instructions }
    );
    this.registerOn(server as unknown as ServerLike);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}
