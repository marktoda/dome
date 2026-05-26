// ConsumerSurface — the protocol-agnostic four-kind aggregation every v1+
// consumer shell composes. See docs/wiki/specs/sdk-surface.md §"Consumer
// surfaces" for the spec. The MCP server is the v0.5-shipped protocol
// adapter over this surface; HTTP / mobile / voice would be future
// adapters.

import type { Vault } from "../vault";
import type { BoundToolSurface } from "../hook-context";
import type { PromptAdapter } from "./prompt-adapters";
import { buildPromptAdapters } from "./prompt-adapters";
import { ResourceAdapter } from "./resource-adapters";
import { buildInstructions } from "./instructions-builder";

export interface ConsumerSurface {
  readonly tools: BoundToolSurface;
  readonly prompts: ReadonlyArray<PromptAdapter>;
  readonly resources: ResourceAdapter;
  readonly instructions: string;
}

/**
 * Build the four-kind ConsumerSurface for `vault`. Two of the kinds resolve
 * synchronously (tools from vault.tools; resources from a ResourceAdapter
 * constructor); the other two are async — `buildPromptAdapters(vault)`
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
    tools: vault.tools,
    prompts,
    resources: new ResourceAdapter(vault),
    instructions,
  };
}
