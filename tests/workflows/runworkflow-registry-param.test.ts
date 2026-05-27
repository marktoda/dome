// B7: runWorkflow accepts an optional WorkflowRegistry. Both forms work:
//   - runWorkflow(vault, name, msg)                — registry built per call
//   - runWorkflow(vault, name, msg, { registry })  — caller-supplied registry
//
// Long-running surfaces (dome serve, future HTTP / voice shells) build ONE
// registry per Vault and thread it through every invocation — which collapses
// the F4 prompt-walk cascade. Short-lived CLI invocations leave it unset.

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { runWorkflow } from "../../src/workflows/agent-loop";
import { WorkflowRegistry } from "../../src/prompts/registry";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";
import type { WorkflowName } from "../../src/workflows/workflow-name";

function makeNoopMockModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

describe("runWorkflow registry param", () => {
  test("runs without a caller-supplied registry (backward-compatible)", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const result = await runWorkflow(res.value, "query", "ping", {
        model: makeNoopMockModel(),
      });
      expect(result.finishReason).toBe("stop");
    } finally {
      await v.cleanup();
    }
  });

  test("runs with a caller-supplied registry and routes through it", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");

      // Sentinel subclass: records every `get()` call so we can confirm
      // runWorkflow used THIS registry instead of constructing a fresh one.
      class SpyRegistry extends WorkflowRegistry {
        public getCalls: string[] = [];
        async get(name: WorkflowName) {
          this.getCalls.push(name);
          return super.get(name);
        }
      }
      const registry = new SpyRegistry(res.value);

      const result = await runWorkflow(res.value, "query", "ping", {
        model: makeNoopMockModel(),
        registry,
      });
      expect(result.finishReason).toBe("stop");
      expect(registry.getCalls).toContain("query");
    } finally {
      await v.cleanup();
    }
  });
});
