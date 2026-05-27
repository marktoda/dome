// B6: WorkflowRegistry's constructor accepts an optional PromptLoader. When
// passed, the registry reuses it (driving the F4 prompt-walk-cascade fix —
// buildAbstractSurface threads its already-constructed loader through here);
// when omitted, the registry constructs its own (backward-compatible).

import { describe, test, expect } from "bun:test";
import { WorkflowRegistry } from "../../src/prompts/registry";
import { PromptLoader } from "../../src/prompts/prompt-loader";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";
import { WorkflowName } from "../../src/workflows/workflow-name";

describe("WorkflowRegistry constructor loader param", () => {
  test("builds its own PromptLoader when none is passed (backward-compatible)", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      // Single-arg form must still work and list the shipped workflows.
      const reg = new WorkflowRegistry(res.value);
      const all = await reg.list();
      expect(all.length).toBeGreaterThan(0);
    } finally {
      await v.cleanup();
    }
  });

  test("reuses a caller-supplied PromptLoader instead of constructing its own", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");

      // Sentinel subclass: records every `load()` call so we can confirm
      // the registry routes through THIS instance (and not a fresh one it
      // constructed internally).
      class SpyLoader extends PromptLoader {
        public loadCalls: string[] = [];
        async load(name: string) {
          this.loadCalls.push(name);
          return super.load(name);
        }
      }
      const spy = new SpyLoader(res.value);

      const reg = new WorkflowRegistry(res.value, spy);
      const def = await reg.get(WorkflowName.Query);
      expect(def).not.toBeNull();
      // The registry MUST have routed `get(query)` through our spy.
      expect(spy.loadCalls).toContain(WorkflowName.Query);
    } finally {
      await v.cleanup();
    }
  });
});
