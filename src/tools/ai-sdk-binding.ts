// AI-SDK Tool<> construction + filterAiTools.
//
// This module imports `ai` (Vercel AI SDK). It MUST NOT be imported by
// @dome/sdk core — only by @dome/sdk/workflows and @dome/sdk/mcp
// consumers. Per CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY, the core entrypoint's
// transitive import graph must exclude `ai`.

import { tool, type Tool, type ToolSet } from "ai";
import type { Vault } from "../vault";
import type { PrivilegedWriter } from "../privileged-writer";
import type { ToolReturn } from "../types";
import { projectEffectsToEvents } from "../event-projection";
import { TOOL_NAMES, TOOL_REGISTRY } from "./registry";

/**
 * Build the AI-SDK `ToolSet` from the canonical registry. Each Tool's
 * `execute()` runs the same schema-parse + compact + invoke pipeline
 * `vault.tools[name]` uses (sharing the registry's metadata), but the
 * resulting shape matches what `generateText` / `streamText` expect.
 *
 * Mutating Tools dispatch their effects through `vault.dispatchEvents`
 * after each invoke — same intrinsic-wrap shape as `bindTools` in
 * registry.ts, so AI-SDK-routed mutations fire `auto-update-index`,
 * `auto-cross-reference`, and declarative-YAML intake hooks identically
 * to MCP-routed and SDK-direct mutations.
 */
export function bindAiSdkTools(vault: Vault, writer: PrivilegedWriter): ToolSet {
  const aiTools: ToolSet = {};
  for (const name of TOOL_NAMES) {
    const entry = TOOL_REGISTRY[name];
    const aiTool = tool({
      description: entry.description,
      inputSchema: entry.schema,
      execute: async (parsed: unknown) => {
        const compacted = entry.compact(parsed as never);
        const out = await entry.invoke(vault, writer, compacted);
        if (entry.mutating) {
          await vault.dispatchEvents(projectEffectsToEvents(out.effects));
        }
        return out;
      },
    }) as unknown as Tool<unknown, ToolReturn<unknown>>;
    aiTools[name] = aiTool;
  }
  return aiTools;
}

/**
 * Filter the bound AI tool set to only the names a workflow declares in
 * its frontmatter `tools:` list. Unknown names are silently dropped
 * (matches v0.5 behavior for forward-compatibility with future plugin tools).
 */
export function filterAiTools(aiTools: ToolSet, allowedNames: ReadonlyArray<string>): ToolSet {
  const out: ToolSet = {};
  for (const name of allowedNames) {
    const t = aiTools[name];
    if (t !== undefined) out[name] = t;
  }
  return out;
}
