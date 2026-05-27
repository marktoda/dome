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
import { bindAiSdkTools } from "../tools/ai-sdk-binding";

export function projectAiSdk(vault: Vault): ToolSet {
  // bindAiSdkTools needs a PrivilegedWriter. Reach the one `openVault`
  // already constructed via the @internal `vault._writer` field — the
  // previous reconstruction via `makePrivilegedWriter(vault.path)` was
  // dead allocation. The Vault's `_writer` is module-private optimization
  // for in-SDK callers; plugin code still reaches the writer only via
  // `HookContext.privilegedWriter` (INDEX_AND_LOG_ARE_DISPATCHER_OWNED).
  const writer = vault._writer;
  return bindAiSdkTools(vault, writer);
}
