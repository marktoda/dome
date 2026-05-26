// ConsumerSurface — the protocol-shell four-kind aggregation every v1+
// consumer composes. See docs/wiki/specs/sdk-surface.md §"Consumer
// surfaces" for the spec. The MCP server is the v0.5-shipped adapter
// over this surface; HTTP / mobile / voice would be future shapes built
// from the same four kinds.
//
// `tools` carries the *protocol-rendered* adapter array (for v0.5: MCP-
// shaped, `dome.*` prefixed). The underlying protocol-agnostic Tool
// surface is reachable via `vault.tools` (BoundToolSurface); the
// ConsumerSurface does not duplicate it.

import type { Vault } from "../vault";
import type { PromptAdapter } from "./prompt-adapters";
import type { ToolAdapter } from "./tool-adapters";
import { buildPromptAdapters } from "./prompt-adapters";
import { buildToolAdapters } from "./tool-adapters";
import { ResourceAdapter } from "./resource-adapters";
import { buildInstructions } from "./instructions-builder";

export interface ConsumerSurface {
  readonly tools: ReadonlyArray<ToolAdapter>;
  readonly prompts: ReadonlyArray<PromptAdapter>;
  readonly resources: ResourceAdapter;
  readonly instructions: string;
}

/**
 * Build the four-kind ConsumerSurface for `vault`. Tools and resources
 * resolve synchronously (`buildToolAdapters(vault)` and the ResourceAdapter
 * constructor); prompts and instructions are async — `buildPromptAdapters(vault)`
 * scans `<vault>/.dome/prompts/` for vault-local overrides;
 * `buildInstructions(vault)` reads `AGENTS.md`. See sdk-surface.md
 * §"Consumer surfaces" for why the signature is `Promise<...>`.
 */
export async function buildConsumerSurface(vault: Vault): Promise<ConsumerSurface> {
  const [prompts, instructions] = await Promise.all([
    buildPromptAdapters(vault),
    buildInstructions(vault),
  ]);
  return {
    tools: buildToolAdapters(vault),
    prompts,
    resources: new ResourceAdapter(vault),
    instructions,
  };
}
