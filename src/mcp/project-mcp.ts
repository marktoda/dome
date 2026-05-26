// Project a Vault's Tool surface into the MCP-shaped raw-input parsers
// every protocol adapter (MCP server today; HTTP / SSE later) consumes.
// Lives in @dome/sdk/mcp so the core entrypoint doesn't transitively
// bundle the MCP SDK per CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY.

import type { Vault } from "../vault";
import type { ToolName } from "../tools/registry";
import type { ToolReturn } from "../types";
import { bindTools } from "../tools/registry";
import { makePrivilegedWriter } from "../privileged-writer";

export interface McpProjection {
  /**
   * Per-Tool parse-and-invoke functions. Each parses raw input through the
   * Tool's Zod schema, compacts via compactX, and invokes the Vault-bound
   * function — sharing the hook-dispatch wrap with vault.tools.
   */
  readonly parsers: Readonly<Record<ToolName, (input: unknown) => Promise<ToolReturn<unknown>>>>;
}

export function projectMcp(vault: Vault): McpProjection {
  const writer = makePrivilegedWriter(vault.path);
  const { parsers } = bindTools(vault, writer);
  return { parsers };
}
