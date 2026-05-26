// DomeMcpServer — thin protocol adapter over ConsumerSurface.
//
// Pre-Phase-B the server constructor took `{ vault }` and built the four
// kinds (tools, prompts, resources, instructions) internally with lazy
// async getters. Post-Phase-B the four-kind aggregation is its own concept
// (ConsumerSurface in src/mcp/consumer-surface.ts); the server takes
// `{ surface, vault }` where surface carries the kinds and vault is still
// needed because buildToolAdapters wraps Vault-bound call sites (the
// adapters need the hook-dispatch wrap from bindTools).
//
// See docs/wiki/specs/mcp-surface.md §"Construction".

import type { Vault } from "../vault";
import type { ConsumerSurface } from "./consumer-surface";
import { buildToolAdapters, type ToolAdapter } from "./tool-adapters";
import { registerHandlers, type ServerLike } from "./handlers";

export interface DomeMcpServerOpts {
  /** The four-kind aggregation per docs/wiki/specs/sdk-surface.md §"Consumer surfaces". */
  surface: ConsumerSurface;
  /**
   * Vault is still passed because buildToolAdapters consumes it (the adapters
   * carry the inputSchemas + parsers, which derive from bindTools(vault, writer)).
   * The surface itself doesn't include tool-adapter shapes — those are
   * MCP-protocol-specific renderings, not part of the protocol-agnostic
   * ConsumerSurface.
   */
  vault: Vault;
}

export class DomeMcpServer {
  readonly tools: ToolAdapter[];

  constructor(private opts: DomeMcpServerOpts) {
    this.tools = buildToolAdapters(opts.vault);
  }

  // Register all 6 request handlers on the given Server-like object. Exposed
  // separately so tests can drive it against a stub Server without spinning
  // up the stdio transport. Called by `serveStdio`.
  registerOn(server: ServerLike): void {
    registerHandlers(server, {
      tools: this.tools,
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
