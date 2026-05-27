// Pins HOOK_DISPATCH_IS_VAULT_BOUND across the AI-SDK projection path.
// Mirror of tests/integration/mcp-hook-dispatch.test.ts for the second
// v0.5-shipped projection (projectAiSdk → vault.tools through generateText).
//
// Without this test, a future change to wrapMutatingInvoke that breaks
// AI-SDK hook dispatch (but not MCP hook dispatch) would slip through —
// the MCP integration test alone doesn't cover the AI-SDK path.

import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { openVault } from "../../src/vault";
import { runWorkflow } from "../../src/workflows/agent-loop";
import { makeTestVault } from "../helpers/make-test-vault";

describe("AI-SDK route fires shipped-default hooks", () => {
  test("writeDocument via projectAiSdk → auto-update-index updates index.md", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const vault = res.value;

      // Mock model: first turn calls writeDocument; second turn stops.
      let callIdx = 0;
      const mock = new MockLanguageModelV3({
        doGenerate: async () => {
          callIdx++;
          if (callIdx === 1) {
            return {
              content: [{
                type: "tool-call",
                toolCallId: "tc1",
                toolName: "writeDocument",
                input: JSON.stringify({
                  path: "wiki/entities/maya.md",
                  body: "# Maya",
                  frontmatter: {
                    type: "entity",
                    created: "2026-05-25",
                    updated: "2026-05-25",
                    sources: [],
                  },
                  opts: { create: true },
                }),
              }],
              finishReason: { unified: "tool-calls", raw: "tool_use" },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
              warnings: [],
            };
          }
          return {
            content: [{ type: "text", text: "done" }],
            finishReason: { unified: "stop", raw: "end_turn" },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
            warnings: [],
          };
        },
      });

      // Migrate workflow's frontmatter includes writeDocument in its
      // bound tools list — driving it via runWorkflow exercises the
      // projectAiSdk(vault) path end-to-end. skipCommit: true so we
      // don't need git to be set up beyond what makeTestVault provides.
      await runWorkflow(vault, "migrate", "Write a test entity page.", {
        model: mock,
        skipCommit: true,
      });

      // drainHooks waits for the async auto-update-index hook to complete.
      await vault.drainHooks();

      // The AI-SDK-routed writeDocument fired auto-update-index.
      const indexBody = await readFile(join(v.path, "index.md"), "utf8");
      expect(indexBody).toContain("[[wiki/entities/maya]]");
    } finally {
      await v.cleanup();
    }
  });
});
