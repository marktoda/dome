// MCP tool adapters. Each adapter wraps one SDK Tool so the MCP server can
// expose it over the protocol. Adapters derive their shape from the central
// `src/tools/registry.ts` — adding a Tool to the registry surfaces it here
// automatically.
//
// The adapter's `handler` returns the inner `Result<T, ToolError>` from
// `ToolReturn` directly. `effects` are dropped at this boundary because
// they don't cross the MCP wire — the Tool already applied them
// side-effectfully (writes, hook dispatch). Keeping the wrapper here means
// the MCP handler in `handlers.ts` works against the same `Result` shape
// the rest of the SDK uses (one less third shape to learn).

import { z } from "zod";
import type { Vault } from "../vault";
import type { Result, ToolError } from "../types";
import { TOOL_NAMES, MCP_TOOL_NAMES, TOOL_REGISTRY, type ToolName } from "../tools/registry";

export interface ToolAdapter {
  /** MCP-protocol name (snake_case, `dome.*` prefix). */
  name: string;
  description: string;
  inputSchema: z.ZodType;
  handler: (input: unknown) => Promise<Result<unknown, ToolError>>;
}

/**
 * Build the MCP tool adapters from the canonical registry. Each entry:
 *
 *   - takes its `name` from `MCP_TOOL_NAMES` (the canonical protocol name)
 *   - takes its `description` and `inputSchema` from `TOOL_REGISTRY` (the
 *     same Zod schema the AI SDK consumer uses — one source of truth)
 *   - delegates the call to `vault.toolParsers[name]`, which parses the raw
 *     input through the schema and invokes the same Vault-bound function
 *     `vault.tools[name]` exposes (sharing the hook-dispatch wrap)
 *
 * Adding an 8th Tool to the registry surfaces it here for free.
 */
export function buildToolAdapters(vault: Vault): ToolAdapter[] {
  return TOOL_NAMES.map((name: ToolName) => {
    const entry = TOOL_REGISTRY[name];
    const aiTool = vault.aiTools[name];
    // The AI SDK tool carries the live Zod schema; we mirror it on the MCP
    // adapter so consumers (and zod-to-json-schema) see the same shape.
    if (aiTool === undefined || aiTool.inputSchema === undefined) {
      throw new Error(`registry is missing AI tool or inputSchema for "${name}"`);
    }
    const parser = vault.toolParsers[name];
    return {
      name: MCP_TOOL_NAMES[name],
      description: entry.description,
      inputSchema: aiTool.inputSchema as z.ZodType,
      handler: async (input: unknown) => (await parser(input)).result,
    };
  });
}
