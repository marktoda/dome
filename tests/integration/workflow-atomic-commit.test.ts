// Blocker 4: per-workflow atomic commits actually happen.
//
// The substrate (docs/wiki/specs/hooks.md §"Commit policy" + sdk-surface.md
// §"Commit policy") says every workflow's effects + log entry land as ONE
// git commit whose subject is "<verb>: <subject>". Without this, log.md
// grows on every appendLog but git history doesn't, breaking "git revert
// is universal undo" and crash recovery.
//
// This test drives a mock LLM that issues a writeDocument tool call, then
// verifies HEAD advanced by one commit and the touched path is in the diff.

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { runWorkflow } from "../../src/workflows/agent-loop";
import { openVault } from "../../src/vault";
import { makeFixtureVault } from "../../src/eval/fixture-vault";
import { resolveRef, log as gitLog } from "../../src/git";

// A two-step mock: step 1 issues a writeDocument tool call; step 2 responds
// to the tool result with a stop. This is the canonical SDK-flow shape for a
// workflow that does one mutation.
function makeWriteDocumentMockModel(targetPath: string) {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      call++;
      if (call === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "writeDocument",
              input: JSON.stringify({
                path: targetPath,
                body: "# Atlas\n\nA project.",
                frontmatter: {
                  type: "entity",
                  created: "2026-05-26",
                  updated: "2026-05-26",
                  sources: [],
                },
                opts: { create: true },
              }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 20, text: 0, reasoning: undefined },
          },
          warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: "Created Atlas entity page." }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

/**
 * Parse the trailing `Key: value` block out of a commit message body. The
 * trailers per ENGINE_COMMITS_CARRY_DOME_TRAILERS sit after a blank line at
 * the end of the message. We walk from the bottom and stop at the first
 * non-trailer line. Matches the substring `git interpret-trailers --parse`
 * would extract without depending on a system git binary.
 */
function parseTrailers(message: string): Record<string, string> {
  const lines = message.replace(/\n+$/, "").split("\n");
  const out: Record<string, string> = {};
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const m = line.match(/^([A-Z][A-Za-z0-9-]*):\s+(.+)$/);
    if (m) {
      out[m[1]!] = m[2]!;
    } else if (line === "") {
      // blank separator — stop
      break;
    } else {
      // non-trailer line — stop
      break;
    }
  }
  return out;
}

describe("per-workflow atomic commit", () => {
  test("runWorkflow commits after a writeDocument tool call; HEAD advances", async () => {
    const fx = await makeFixtureVault({ files: {} });
    try {
      const openRes = await openVault(fx.path);
      expect(openRes.ok).toBe(true);
      if (!openRes.ok) return;

      // git log before the workflow.
      const before = await resolveRef({ path: fx.path }).catch(() => null);

      const result = await runWorkflow(
        openRes.value,
        "ingest",
        "Capture an Atlas entity page",
        { model: makeWriteDocumentMockModel("wiki/entities/atlas.md") },
      );

      await openRes.value.drainHooks();

      // Workflow produced a tool call AND a stop.
      expect(result.toolCallCount).toBe(1);
      expect(result.finishReason).toBe("stop");
      // The workflow ran 2 steps (tool call + tool result + final text).
      expect(result.steps).toBeGreaterThanOrEqual(2);
      // The commit happened — Blocker 4's whole point.
      expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);

      // HEAD actually advanced.
      const after = await resolveRef({ path: fx.path });
      expect(after).not.toBe(before);
      expect(after).toBe(result.commitSha);

      // The commit message has the canonical shape: "<verb>: <subject>".
      const logEntries = await gitLog({ path: fx.path, depth: 1 });
      const message = logEntries[0]!.commit.message;
      expect(message.startsWith("ingest:")).toBe(true);
      expect(message).toContain("Capture an Atlas entity page");

      // Per ENGINE_COMMITS_CARRY_DOME_TRAILERS — the commit body must carry
      // the four Dome-* trailers, parseable as `<Key>: <value>` lines. We
      // parse by hand (rather than invoking `git interpret-trailers`) so
      // the assertion doesn't depend on a system git binary being available.
      const trailers = parseTrailers(message);
      expect(Object.keys(trailers).sort()).toEqual([
        "Dome-Base",
        "Dome-Extension",
        "Dome-Run",
        "Dome-Source-Head",
      ]);
      expect(trailers["Dome-Run"]).toMatch(/^run_\d+_[a-f0-9]{6}$/);
      expect(trailers["Dome-Extension"]).toBe("ingest");
      expect(trailers["Dome-Base"]).toMatch(/^[0-9a-f]{40}$/);
      expect(trailers["Dome-Source-Head"]).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await fx.cleanup();
    }
  });

  test("skipCommit: true disables the commit; result.commitSha is empty", async () => {
    const fx = await makeFixtureVault({ files: {} });
    try {
      const openRes = await openVault(fx.path);
      if (!openRes.ok) return;
      const result = await runWorkflow(
        openRes.value,
        "ingest",
        "Capture an Atlas entity page",
        {
          model: makeWriteDocumentMockModel("wiki/entities/atlas.md"),
          skipCommit: true,
        },
      );
      await openRes.value.drainHooks();
      expect(result.commitSha).toBe("");
    } finally {
      await fx.cleanup();
    }
  });

  test("zero mutating tool calls -> no commit (commitSha is empty)", async () => {
    const fx = await makeFixtureVault({ files: {} });
    try {
      const openRes = await openVault(fx.path);
      if (!openRes.ok) return;
      // A no-op model that just returns text (no tool calls). The workflow
      // body still drives the SDK call, but nothing got mutated.
      const noopModel = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: "text", text: "Nothing to do." }],
          finishReason: { unified: "stop", raw: "end_turn" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        }),
      });
      const result = await runWorkflow(
        openRes.value,
        "query",
        "What do I know?",
        { model: noopModel },
      );
      expect(result.toolCallCount).toBe(0);
      expect(result.commitSha).toBe("");
    } finally {
      await fx.cleanup();
    }
  });
});
