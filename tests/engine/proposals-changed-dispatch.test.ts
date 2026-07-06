// proposals-changed-dispatch — the `proposals.changed` flag → tick-epilogue →
// dispatch contract, end-to-end through the compiler host (processors.md
// §"Triggers and signals"). Mirrors the questions.changed precedent at
// tests/harness/scenarios/triggers/questions-changed-dispatch.scenario.test.ts,
// adapted for proposals.changed at the engine level: the production emit
// point (the enqueueProposal sink) does not exist yet, so `markProposalsChanged`
// is called directly as the emit point — which also lets the subscriber's own
// run() closure re-set the flag MID-DISPATCH, something a scenario fixture
// bundle cannot do (fixture processors have no runtime handle).
//
// The multi-tick contract pinned here:
//
//   1. No flag → no dispatch: a quiet tick never dispatches the subscriber.
//   2. Flag set → the subscribed garden processor is dispatched exactly once
//      on the next tick.
//   3. Recursion guard: the subscriber re-sets the flag DURING that epilogue
//      dispatch — the tick must NOT loop; still exactly one run this tick.
//   4. Carryover: the mid-dispatch re-set survives on the host-scoped flag,
//      so the immediately following quiet tick dispatches exactly once more.
//   5. Termination: a further quiet tick has a clear flag — zero dispatches.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineProcessor } from "../../src/core/processor";
import {
  detectDrift,
  markProposalsChanged,
  runCompilerHostTick,
} from "../../src/engine/host/compiler-host";
import {
  openVaultRuntime,
  type VaultRuntime,
} from "../../src/engine/host/vault-runtime";
import { commit, initRepo } from "../../src/git";
import { buildRegistry } from "../../src/processors/registry";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

async function makeGitVault(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "dome-proposals-changed-"));
  roots.push(root);
  await initRepo(root);
  await mkdir(join(root, "wiki"), { recursive: true });
  await writeFile(join(root, "wiki/seed.md"), "# Seed\n");
  await commit({ path: root, message: "init\n", files: ["wiki/seed.md"] });
  await mkdir(join(root, ".dome", "state"), { recursive: true });
  return root;
}

async function tick(runtime: VaultRuntime, vaultPath: string): Promise<void> {
  const drift = await detectDrift(vaultPath);
  if (
    drift.kind === "detached-head" ||
    drift.kind === "no-commits" ||
    drift.kind === "diverged"
  ) {
    throw new Error(`tick: unworkable state '${drift.kind}'`);
  }
  const result = await runCompilerHostTick({ runtime, drift });
  if (result.kind === "busy") {
    throw new Error(`tick: compiler host busy for '${result.branch}'`);
  }
}

describe("proposals.changed: flag → tick-epilogue dispatch → snapshot-then-clear carry", () => {
  test(
    "dispatches once per tick; a mid-dispatch re-set carries to the next tick and then terminates",
    async () => {
      const vaultPath = await makeGitVault();

      // Closure state: `runtime` is assigned after open so the subscriber's
      // run() can call markProposalsChanged(runtime) — the mid-dispatch
      // re-set that the recursion guard + carryover contract must absorb.
      let runtime: VaultRuntime | undefined;
      let dispatches = 0;
      const subscriber = defineProcessor({
        id: "test.proposals-changed.subscriber",
        version: "0.1.0",
        phase: "garden",
        triggers: [{ kind: "signal", name: "proposals.changed" }],
        capabilities: [],
        run: async () => {
          dispatches += 1;
          if (dispatches === 1 && runtime !== undefined) {
            // First dispatch only: re-set the flag DURING the epilogue
            // dispatch. The tick must not loop; the next tick must carry.
            markProposalsChanged(runtime);
          }
          return [];
        },
      });

      const registryResult = buildRegistry([subscriber]);
      expect(registryResult.ok).toBe(true);
      if (!registryResult.ok) return;

      const runtimeResult = await openVaultRuntime({
        vaultPath,
        registry: registryResult.value,
        extensions: [{ name: "test.proposals-changed", version: "0.1.0" }],
        processorVersions: [
          { id: "test.proposals-changed.subscriber", version: "0.1.0" },
        ],
      });
      expect(runtimeResult.ok).toBe(true);
      if (!runtimeResult.ok) return;
      runtime = runtimeResult.value;

      try {
        // Seed tick: initializes the adopted ref. No flag → no dispatch.
        await tick(runtime, vaultPath);
        expect(dispatches).toBe(0);

        // Quiet tick, still no flag → still no dispatch (contract 1).
        await tick(runtime, vaultPath);
        expect(dispatches).toBe(0);

        // Emit point: set the flag, then tick. The epilogue must dispatch
        // the subscriber EXACTLY once (contract 2) even though the
        // subscriber re-sets the flag mid-dispatch (contract 3 — no loop).
        markProposalsChanged(runtime);
        await tick(runtime, vaultPath);
        expect(dispatches).toBe(1);

        // Carryover: the mid-dispatch re-set survived on the host-scoped
        // flag, so this quiet tick dispatches exactly once more (contract 4).
        // The subscriber does not re-set on its second run, so the chain ends.
        await tick(runtime, vaultPath);
        expect(dispatches).toBe(2);

        // Termination: flag is clear, nothing sets it → no dispatch
        // (contract 5).
        await tick(runtime, vaultPath);
        expect(dispatches).toBe(2);
      } finally {
        await runtime.close();
      }
    },
    30_000,
  );
});
