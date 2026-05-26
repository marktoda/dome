// High 6: multi-hop hook cycles must trigger the depth safety net.
//
// Substrate (docs/wiki/specs/hooks.md §"Execution model") says cycle
// prevention is two-layer:
//   1. per-(handler, target) repetition check — catches direct self-write
//      within one event burst
//   2. depth safety net (hooks.max_causation_depth, default 50) — catches
//      runaway chains that don't repeat (handler, target) but grow
//      unboundedly
//
// Previously the chain was reset to [] on every Tool->Effect->event
// re-entry through wrap(), so the depth net was mathematically unreachable.
// AsyncLocalStorage now threads the chain across re-entries.

import { describe, test, expect } from "bun:test";
import { HookDispatcher, type CycleInfo, type DispatcherCtxFactory } from "../../src/hook-dispatcher";
import { HookRegistry } from "../../src/hook-registry";
import { openVault } from "../../src/vault";
import { makePrivilegedWriter } from "../../src/privileged-writer";
import { makeTestVault } from "../helpers/make-test-vault";

describe("multi-hop hook cycle detection", () => {
  test("depth safety net fires when handlers re-enter dispatchEvents recursively", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const vault = res.value;

      // Build a fresh registry + dispatcher with a small max depth so the test
      // doesn't have to chase 50 hops. The vault's own registry is wired with
      // shipped-default hooks; we're testing the dispatcher mechanism directly.
      const registry = new HookRegistry();
      const dispatcher = new HookDispatcher(registry, { maxCausationDepth: 3 });

      const cycleInfos: CycleInfo[] = [];
      dispatcher.onCycleDetected((info) => { cycleInfos.push(info); });

      // Two handlers that bounce events between each other, each writing to
      // a distinct target path so the per-(handler, target) check WON'T
      // catch it — only the depth net should.
      let pingCalls = 0;
      let pongCalls = 0;
      registry.register({
        id: "ping",
        pattern: "test.ping",
        source: "vault-local",
        async: false,
        idempotent: true,
        handler: async () => {
          pingCalls++;
          // Re-dispatch a 'pong' event with a unique target path each time
          // so per-(handler, target) doesn't catch the loop.
          await dispatcher.dispatchEvents([{ kind: "test.pong", path: `target-${pingCalls}` }], ctxFactory);
        },
      });
      registry.register({
        id: "pong",
        pattern: "test.pong",
        source: "vault-local",
        async: false,
        idempotent: true,
        handler: async () => {
          pongCalls++;
          await dispatcher.dispatchEvents([{ kind: "test.ping", path: `target-${pongCalls}` }], ctxFactory);
        },
      });

      const ctxFactory: DispatcherCtxFactory = {
        baseCtx: { tools: vault.tools, vault: { path: vault.path } },
        privilegedWriter: makePrivilegedWriter(vault.path),
      };

      await dispatcher.dispatchEvents([{ kind: "test.ping", path: "seed" }], ctxFactory);

      // With maxCausationDepth: 3, the chain should grow to length 3 then
      // the next re-entry hits the safety net.
      expect(cycleInfos.length).toBeGreaterThanOrEqual(1);
      const info = cycleInfos[0]!;
      expect(info.depth).toBeGreaterThanOrEqual(3);
      // The chain should have actual links (proving causation was threaded).
      expect(info.chain.length).toBeGreaterThanOrEqual(3);
      // The chain mixes ping and pong as the loop bounces.
      const ids = info.chain.map(l => l.handlerId);
      expect(ids).toContain("ping");
      expect(ids).toContain("pong");
    } finally {
      await v.cleanup();
    }
  });

  test("per-(handler, target) check still catches direct self-re-entry against the same target", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const vault = res.value;

      const registry = new HookRegistry();
      const dispatcher = new HookDispatcher(registry, { maxCausationDepth: 50 });
      const cycleInfos: CycleInfo[] = [];
      dispatcher.onCycleDetected((info) => { cycleInfos.push(info); });

      // Single handler that re-dispatches an event matching itself, same path.
      // The per-(handler, target) check catches it on the first re-entry
      // (much earlier than the depth-50 net).
      let runs = 0;
      registry.register({
        id: "self-loop",
        pattern: "test.self",
        source: "vault-local",
        async: false,
        idempotent: true,
        handler: async () => {
          runs++;
          if (runs > 10) return; // safety guard if the check fails
          await dispatcher.dispatchEvents([{ kind: "test.self", path: "same-path" }], ctxFactory);
        },
      });

      const ctxFactory: DispatcherCtxFactory = {
        baseCtx: { tools: vault.tools, vault: { path: vault.path } },
        privilegedWriter: makePrivilegedWriter(vault.path),
      };

      await dispatcher.dispatchEvents([{ kind: "test.self", path: "same-path" }], ctxFactory);

      // First fire runs; second fire's (self-loop, same-path) matches the
      // chain so wouldCycle refuses and emits a CycleInfo with depth 1.
      expect(runs).toBe(1);
      expect(cycleInfos.length).toBe(1);
      expect(cycleInfos[0]!.triggeringHandler).toBe("self-loop");
    } finally {
      await v.cleanup();
    }
  });
});
