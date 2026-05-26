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
import { TOOL_NAMES, TOOL_REGISTRY, wrapMutatingInvoke, type ToolRegistryEntry } from "./registry";

/**
 * Build the AI-SDK `ToolSet` from the canonical registry. Each Tool's
 * `execute()` consumes the same single-source `wrapMutatingInvoke` helper
 * `bindTools` (vault.tools) uses — mutating Tools fire effects through
 * `vault.dispatchEvents` after each invoke identically across every
 * projection. See HOOK_DISPATCH_IS_VAULT_BOUND.
 *
 * The hand-rolled dispatch loop that pre-dated `wrapMutatingInvoke` is
 * gone; this projection delegates rather than re-implementing. A future
 * change to the wrap (causation metadata, backpressure gate, closed-flag
 * pre-check) lands in one place and inherits across every projection.
 */
export function bindAiSdkTools(vault: Vault, writer: PrivilegedWriter): ToolSet {
  const aiTools: ToolSet = {};
  for (const name of TOOL_NAMES) {
    // TOOL_REGISTRY[name] is a union of entry shapes; widen to the wide entry
    // type so wrapMutatingInvoke's generics don't narrow to the first member.
    // The runtime check inside wrapMutatingInvoke (entry.mutating) keeps the
    // wrap logic correct regardless of the static type. Mirrors the same
    // pattern bindTools uses in registry.ts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = TOOL_REGISTRY[name] as ToolRegistryEntry<any, any, any>;
    const invoke = wrapMutatingInvoke(entry, vault, writer);
    const aiTool = tool({
      description: entry.description,
      inputSchema: entry.schema,
      execute: async (parsed: unknown) => {
        const compacted = entry.compact(parsed as never);
        return invoke(compacted);
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
