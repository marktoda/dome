// @dome/sdk/mcp — the MCP server + ConsumerSurface aggregation surface.
//
// This entrypoint carries the @modelcontextprotocol/sdk dep. Consumers
// that don't speak MCP import from @dome/sdk (core) instead — see
// docs/wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY.md.

export { DomeMcpServer } from "./server";
export type { DomeMcpServerOpts } from "./server";

export { buildConsumerSurface } from "./consumer-surface";
export type { ConsumerSurface } from "./consumer-surface";

export { projectMcp } from "./project-mcp";
export type { McpProjection } from "./project-mcp";

export { buildToolAdapters } from "./tool-adapters";
export type { ToolAdapter } from "./tool-adapters";

export { buildPromptAdapters } from "./prompt-adapters";
export type { PromptAdapter } from "./prompt-adapters";

export { ResourceAdapter, ResourceUri } from "./resource-adapters";
export type { ResourceContent } from "./resource-adapters";

export { buildInstructions } from "./instructions-builder";

export { McpToolName } from "./tool-names";
