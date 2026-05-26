// Project a Vault's Tool surface into the AI-SDK `ToolSet` shape consumed
// by `generateText` / `streamText`. Lives in @dome/sdk/workflows so the
// core @dome/sdk entrypoint doesn't transitively bundle `ai` per
// CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY.
//
// The projection delegates to the same `bindTools` machinery that
// previously built `vault.aiTools` eagerly inside openVault; calling
// projectAiSdk(vault) at workflow-runner construction time gives the
// caller the AI-SDK shape on demand.

import type { ToolSet } from "ai";
import type { Vault } from "../vault";
import { bindTools } from "../tools/registry";
import { makePrivilegedWriter } from "../privileged-writer";

export function projectAiSdk(vault: Vault): ToolSet {
  // bindTools needs a PrivilegedWriter; reconstruct one (cheap factory)
  // to avoid leaking the privileged writer through the public Vault
  // surface. The Tools returned by bindTools are AI SDK Tool<> shapes;
  // their execute() handlers close over the writer.
  const writer = makePrivilegedWriter(vault.path);
  const { aiTools } = bindTools(vault, writer);
  return aiTools;
}
