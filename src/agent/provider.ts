// src/agent/provider.ts
//
// Adapts the vault's configured command model provider into the loop's
// AskStepFn seam. No LLM SDK — all model calls go through the subprocess
// command provider contract (dome.model-provider.step/v1).

import { loadCapabilityPolicy } from "../engine/core/capability-policy";
import { buildCommandModelStepProvider } from "../engine/host/command-model-provider";
import type { ModelStepProvider } from "../engine/core/model-invoke";
import type { AskStepFn } from "./loop";

/** Wrap a ModelStepProvider into the loop's AskStepFn, binding model + signal. */
export function askStepFromProvider(
  provider: ModelStepProvider,
  opts: { readonly model?: string | undefined; readonly signal: AbortSignal },
): AskStepFn {
  return async ({ messages, tools }) => {
    const resp = await provider({
      messages,
      tools,
      signal: opts.signal,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    });
    return {
      ...(resp.text !== undefined ? { text: resp.text } : {}),
      ...(resp.toolCalls !== undefined ? { toolCalls: resp.toolCalls } : {}),
    };
  };
}

/** Build the step provider from the vault's configured command model provider. */
export async function getModelStepProvider(
  vaultPath: string,
): Promise<{ kind: "ok"; provider: ModelStepProvider } | { kind: "no-provider" } | { kind: "error"; message: string }> {
  const policy = await loadCapabilityPolicy(vaultPath);
  if (!policy.ok) return { kind: "error", message: policy.error };
  const cfg = policy.value.runtime.modelProvider;
  if (cfg === undefined) return { kind: "no-provider" };
  const provider = buildCommandModelStepProvider(cfg, { cwd: vaultPath });
  return { kind: "ok", provider };
}
