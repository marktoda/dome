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
import { TOOL_NAMES, MCP_TOOL_NAMES, TOOL_REGISTRY, type ToolName, bindTools } from "../tools/registry";
import { makePrivilegedWriter } from "../privileged-writer";

// The MCP adapter reads tool input schemas directly from TOOL_REGISTRY
// (which carries the Zod schemas without any AI-SDK dependency). This
// keeps the adapter inside @dome/sdk/mcp clean even though the registry
// itself stays AI-SDK-free.

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
 *     same Zod schema every consumer of the seven Tools uses — one source
 *     of truth)
 *   - delegates the call to the per-Tool parser from `bindTools(vault, writer)`,
 *     which parses the raw input through the schema and invokes the same
 *     Vault-bound function `vault.tools[name]` exposes. The hook-dispatch
 *     wrap is intrinsic to `bindTools` (see registry.ts and sdk-surface.md
 *     §"Hook dispatch is intrinsic"), so MCP-routed mutations fire the
 *     same hooks as SDK-direct calls.
 *
 * Adding an 8th Tool to the registry surfaces it here for free.
 *
 * Why this lives in `@dome/sdk/mcp` and not core: the `ToolAdapter` shape
 * is MCP-protocol-shaped (`dome.*` snake_case names, the `handler: (input)
 * => Result` signature MCP servers consume). It has nothing AI-SDK-shaped
 * about it, and `bindTools` itself stays in core and AI-SDK-free
 * (CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY is structurally true regardless of
 * who imports the registry). The adapter only belongs alongside the
 * protocol it serves.
 */
export function buildToolAdapters(vault: Vault): ToolAdapter[] {
  const writer = makePrivilegedWriter(vault.path);
  const { parsers } = bindTools(vault, writer);
  return TOOL_NAMES.map((name: ToolName) => {
    const entry = TOOL_REGISTRY[name];
    const parser = parsers[name];
    return {
      name: MCP_TOOL_NAMES[name],
      description: entry.description,
      inputSchema: entry.schema as z.ZodType,
      handler: async (input: unknown) => (await parser(input)).result,
    };
  });
}
