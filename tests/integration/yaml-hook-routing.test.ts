// End-to-end test for Blocker 2 wiring:
//   1. dome init writes intake-raw.yaml
//   2. openVault discovers it via the declarative YAML loader
//   3. an event matching the YAML's event+path_pattern is routed to the
//      registered handler
//   4. the handler invokes runWorkflow with the named workflow
//
// runWorkflow itself requires ANTHROPIC_API_KEY at runtime; this test mocks
// the agent-loop module so we can assert the handler reaches it WITHOUT a
// real LLM call. The assertion: the workflow name + the event-shaped user
// message arrive at the mock with the right shape.

import { describe, test, expect, mock, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domeInit } from "../../src/cli/commands/init";
import { openVault } from "../../src/vault";

// Capture runWorkflow calls without invoking the real one (which would hit
// the LLM). Bun's `mock.module` is the canonical seam.
type RunArgs = { workflowName: string; userMessage: string };
const runCalls: RunArgs[] = [];

mock.module("../../src/workflows/agent-loop", () => ({
  runWorkflow: async (_vault: unknown, workflowName: string, userMessage: string) => {
    runCalls.push({ workflowName, userMessage });
    return { text: "ok", steps: [], finishReason: { unified: "stop", raw: "stop" }, toolCallCount: 0 };
  },
  buildAiSdkTools: () => ({}),
  DEFAULT_MODEL: "claude-opus-4-7",
  DEFAULT_MAX_STEPS: 50,
}));

afterEach(() => {
  runCalls.length = 0;
});

describe("YAML hook routing: dropped inbox file -> registered handler -> runWorkflow", () => {
  test("intake-raw.yaml shipped by dome init routes inbox/raw events to the ingest workflow", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-yaml-route-"));
    const vaultPath = join(base, "vault");
    try {
      const initRes = await domeInit(vaultPath);
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;

      // Drop a raw file into the inbox.
      await writeFile(
        join(vaultPath, "inbox", "raw", "test-thought.md"),
        "# Captured\n\nA thought.\n",
      );

      const openRes = await openVault(vaultPath);
      expect(openRes.ok).toBe(true);
      if (!openRes.ok) return;
      const vault = openRes.value;

      // Drive a single inbox-raw event through the vault's dispatcher (this
      // is what reconcile would do during its phase-1 inbox scan).
      await vault.dispatchEvents([
        { kind: "document.written.inbox.raw", path: "inbox/raw/test-thought.md", diff: "[new]" },
      ]);
      await vault.drainHooks();

      // The intake-raw.yaml handler should have invoked runWorkflow once for
      // the "ingest" workflow, carrying the event's path in the user message.
      expect(runCalls.length).toBe(1);
      expect(runCalls[0]!.workflowName).toBe("ingest");
      expect(runCalls[0]!.userMessage).toContain("inbox/raw/test-thought.md");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("path_pattern filters out events that don't match the configured prefix", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-yaml-filter-"));
    const vaultPath = join(base, "vault");
    try {
      const initRes = await domeInit(vaultPath);
      if (!initRes.ok) return;
      const openRes = await openVault(vaultPath);
      if (!openRes.ok) return;
      const vault = openRes.value;
      // An event matching the event pattern but NOT the path_pattern of
      // intake-raw.yaml (inbox/raw/*) should not invoke runWorkflow.
      await vault.dispatchEvents([
        { kind: "document.written.wiki.entity", path: "wiki/entities/danny.md", diff: "[new]" },
      ]);
      await vault.drainHooks();
      expect(runCalls.length).toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
