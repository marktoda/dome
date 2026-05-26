// End-to-end test for Blocker 2 wiring:
//   1. dome init writes intake-raw.yaml
//   2. the declarative YAML loader registers it against a HookRegistry
//   3. an event matching the YAML's event+path_pattern is routed to the
//      registered handler
//   4. the handler invokes runWorkflow with the named workflow
//
// Uses the loader's `runWorkflow` injector instead of Bun's mock.module
// (which would pollute later-loaded tests in the same process).

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domeInit } from "../../src/cli/commands/init";
import { openVault } from "../../src/vault";
import { loadDeclarativeHooks, type RunWorkflowFn } from "../../src/hooks/yaml-loader";
import { HookRegistry } from "../../src/hook-registry";
import { HookDispatcher } from "../../src/hook-dispatcher";
import { makePrivilegedWriter } from "../../src/privileged-writer";

const runCalls: { workflowName: string; userMessage: string }[] = [];
const stubRunWorkflow: RunWorkflowFn = async (_vault, workflowName, userMessage) => {
  runCalls.push({ workflowName, userMessage });
  return { text: "ok" };
};

afterEach(() => { runCalls.length = 0; });

describe("YAML hook routing: dropped inbox file -> registered handler -> runWorkflow", () => {
  test("intake-raw.yaml shipped by dome init routes inbox/raw events to the ingest workflow", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-yaml-route-"));
    const vaultPath = join(base, "vault");
    try {
      const initRes = await domeInit(vaultPath);
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;

      await writeFile(
        join(vaultPath, "inbox", "raw", "test-thought.md"),
        "# Captured\n\nA thought.\n",
      );

      // Open the vault but build our own registry + dispatcher so we can inject
      // a stub runWorkflow into the YAML loader without touching agent-loop's
      // module identity.
      const openRes = await openVault(vaultPath);
      expect(openRes.ok).toBe(true);
      if (!openRes.ok) return;
      const vault = openRes.value;

      const registry = new HookRegistry();
      await loadDeclarativeHooks(vault, registry, { runWorkflow: stubRunWorkflow });
      const dispatcher = new HookDispatcher(registry);

      // Drive an inbox-raw event through OUR test dispatcher (not the vault's
      // built-in one, which uses the real runWorkflow).
      await dispatcher.dispatchEvents(
        [{ kind: "document.written.inbox.raw", path: "inbox/raw/test-thought.md", diff: "[new]" }],
        {
          baseCtx: { tools: vault.tools, vault: { path: vault.path } },
          privilegedWriter: makePrivilegedWriter(vault.path),
        },
      );
      await dispatcher.drain();

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

      const registry = new HookRegistry();
      await loadDeclarativeHooks(vault, registry, { runWorkflow: stubRunWorkflow });
      const dispatcher = new HookDispatcher(registry);

      await dispatcher.dispatchEvents(
        [{ kind: "document.written.wiki.entity", path: "wiki/entities/danny.md", diff: "[new]" }],
        {
          baseCtx: { tools: vault.tools, vault: { path: vault.path } },
          privilegedWriter: makePrivilegedWriter(vault.path),
        },
      );
      await dispatcher.drain();
      expect(runCalls.length).toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
