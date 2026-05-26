// renderMcp — project AbstractSurface to McpSurface (MCP wire shape).
// Applies the dome.* / dome.workflow.* / dome:// naming conventions per
// docs/wiki/specs/mcp-surface.md and the `dome.system_prompt` first-class
// MCP prompt per docs/wiki/specs/mcp-surface.md §"Prompts exposed".

import { z } from "zod";
import type { AbstractSurface, PromptDescriptor } from "../abstract-surface";
import type { Result, ToolError, ToolReturn } from "../types";
import { TOOL_NAMES, MCP_TOOL_NAMES, TOOL_REGISTRY, type ToolName, type ToolRegistryEntry } from "../tools/registry";
import { ResourceAdapter } from "./resource-adapters";

/** MCP-protocol tool adapter shape. */
export interface ToolAdapter {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  handler: (input: unknown) => Promise<Result<unknown, ToolError>>;
}

/** MCP-protocol prompt adapter shape. */
export interface McpPromptAdapter {
  name: string;
  description: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  body: string;
}

/** MCP-rendered four-kind aggregation. Consumed by DomeMcpServer. */
export interface McpSurface {
  readonly tools: ReadonlyArray<ToolAdapter>;
  readonly prompts: ReadonlyArray<McpPromptAdapter>;
  readonly resources: ResourceAdapter;
  readonly instructions: string;
}

const MCP_SYSTEM_PROMPT_NAME = "dome.system_prompt";
const MCP_WORKFLOW_PREFIX = "dome.workflow.";

function projectPromptName(descriptor: PromptDescriptor): string {
  if (descriptor.name === "system-base") return MCP_SYSTEM_PROMPT_NAME;
  return `${MCP_WORKFLOW_PREFIX}${descriptor.name.replace(/-/g, "_")}`;
}

/**
 * Project AbstractSurface to MCP wire shape. Synchronous — no I/O. The
 * async work (prompt scanning, AGENTS.md reading) happened in
 * buildAbstractSurface.
 *
 * The Tool projection consumes surface.tools (the BoundToolSurface that
 * vault.tools exposes — already wrapped with wrapMutatingInvoke per
 * HOOK_DISPATCH_IS_VAULT_BOUND) and wraps each entry as an MCP ToolAdapter
 * with the dome.* snake_case name and a handler that returns
 * Result<T, ToolError> directly.
 */
export function renderMcp(surface: AbstractSurface): McpSurface {
  const tools: ToolAdapter[] = TOOL_NAMES.map((name: ToolName) => {
    // Widen the union (see ai-sdk-binding.ts / registry.ts for the same pattern).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = TOOL_REGISTRY[name] as ToolRegistryEntry<any, any, any>;
    const bound = surface.tools[name];
    return {
      name: MCP_TOOL_NAMES[name],
      description: entry.description,
      inputSchema: entry.schema as z.ZodType,
      handler: async (input: unknown) => {
        // Parse raw input through the entry's schema, compact, and invoke
        // the BoundToolSurface function (which is already hook-dispatch
        // wrapped via wrapMutatingInvoke).
        const parsed = entry.schema.parse(input);
        const compacted = entry.compact(parsed);
        const out = await (bound as (input: unknown) => Promise<ToolReturn<unknown>>)(compacted);
        return out.result;
      },
    };
  });

  const prompts: McpPromptAdapter[] = surface.prompts.map((descriptor) => ({
    name: projectPromptName(descriptor),
    description: descriptor.description,
    body: descriptor.body,
  }));

  const resources = new ResourceAdapter(surface);

  return {
    tools,
    prompts,
    resources,
    instructions: surface.instructions,
  };
}
