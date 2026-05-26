// Pins the wrapMutatingInvoke helper's contract: invoke + (if mutating)
// dispatch effects. Both bindTools and bindAiSdkTools consume this helper;
// see docs/wiki/invariants/HOOK_DISPATCH_IS_VAULT_BOUND.md.

import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { TOOL_REGISTRY, wrapMutatingInvoke } from "../../src/tools/registry";
import { makePrivilegedWriter } from "../../src/privileged-writer";
import { makeTestVault } from "../helpers/make-test-vault";

describe("wrapMutatingInvoke", () => {
  test("returns a function that invokes the entry and dispatches events on mutating Tools", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const vault = res.value;
      const writer = makePrivilegedWriter(vault.path);

      let dispatchCount = 0;
      const originalDispatch = vault.dispatchEvents;
      // Reassign dispatchEvents on the vault instance to spy.
      (vault as { dispatchEvents: typeof vault.dispatchEvents }).dispatchEvents = async (events) => {
        dispatchCount += events.length;
        return originalDispatch(events);
      };

      const entry = TOOL_REGISTRY.writeDocument;
      const invoke = wrapMutatingInvoke(entry, vault, writer);

      const out = await invoke({
        path: "wiki/entities/test.md",
        body: "# Test",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });

      expect(out.result.ok).toBe(true);
      expect(dispatchCount).toBeGreaterThan(0);

      await vault.drainHooks();
    } finally {
      await v.cleanup();
    }
  });

  test("does NOT dispatch events on read-only Tools", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const vault = res.value;
      const writer = makePrivilegedWriter(vault.path);

      let dispatchCount = 0;
      const originalDispatch = vault.dispatchEvents;
      (vault as { dispatchEvents: typeof vault.dispatchEvents }).dispatchEvents = async (events) => {
        dispatchCount += events.length;
        return originalDispatch(events);
      };

      const entry = TOOL_REGISTRY.readDocument;
      const invoke = wrapMutatingInvoke(entry, vault, writer);

      await invoke({ path: "index.md" });
      expect(dispatchCount).toBe(0);
    } finally {
      await v.cleanup();
    }
  });
});
