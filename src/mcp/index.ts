// @dome/sdk/mcp — the MCP server + per-protocol render layer.
//
// This entrypoint carries the @modelcontextprotocol/sdk dep. Consumers
// that don't speak MCP import from @dome/sdk (core) instead — see
// docs/wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY.md.

export { DomeMcpServer } from "./server";
export type { DomeMcpServerOpts } from "./server";

export { renderMcp } from "./render-mcp";
export type { McpSurface, ToolAdapter, McpPromptAdapter } from "./render-mcp";

export { ResourceAdapter, ResourceUri } from "./resource-adapters";
export type { ResourceContent } from "./resource-adapters";
