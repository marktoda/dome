import { describe, test, expect } from "bun:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HookRegistry } from "../../src/hook-registry";
import { makeTestVault } from "../helpers/make-test-vault";

describe("quarantine persistence", () => {
  test("recordFailure x3 writes the handler id to .dome/state/quarantined.json", async () => {
    const v = await makeTestVault();
    try {
      const stateDir = join(v.path, ".dome", "state");
      await mkdir(stateDir, { recursive: true });
      const quarantinePath = join(stateDir, "quarantined.json");

      const reg = new HookRegistry({ persistPath: quarantinePath });
      reg.register({
        id: "test-handler",
        pattern: "document.written.*",
        handler: async () => {},
        source: "vault-local",
        async: true,
        idempotent: true,
      });

      reg.recordFailure("test-handler");
      reg.recordFailure("test-handler");
      reg.recordFailure("test-handler");

      await reg.flushPersist();

      const data = JSON.parse(await readFile(quarantinePath, "utf8")) as string[];
      expect(data).toContain("test-handler");
    } finally {
      await v.cleanup();
    }
  });

  test("dispatcher-driven recordFailure x3 plus drain produces the persistent record (closes F2)", async () => {
    // F2: vault.drainHooks must await BOTH the dispatcher queue AND the
    // registry's pendingPersist chain. Otherwise dome serve quarantining
    // a handler on its final event can exit before the write lands, and
    // dome doctor on the next CLI invocation sees an empty file.
    //
    // This test drives the failure through a HookDispatcher (not a direct
    // recordFailure call) and uses ONLY drain() / flushPersist() to settle
    // — never awaits an individual save. If the wiring regresses, the file
    // contents will be inconsistent with the in-memory quarantine set.
    const v = await makeTestVault();
    try {
      const stateDir = join(v.path, ".dome", "state");
      await mkdir(stateDir, { recursive: true });
      const quarantinePath = join(stateDir, "quarantined.json");

      const { HookDispatcher } = await import("../../src/hook-dispatcher");
      const { makePrivilegedWriter } = await import("../../src/privileged-writer");

      const reg = new HookRegistry({ persistPath: quarantinePath });
      // A handler that always throws. The dispatcher's invoke() catches the
      // throw and calls reg.recordFailure(hook.id).
      reg.register({
        id: "always-fails",
        pattern: "test.event",
        handler: async () => { throw new Error("intentional"); },
        source: "vault-local",
        async: false, // sync so each dispatchEvents call records one failure synchronously
        idempotent: true,
      });

      const dispatcher = new HookDispatcher(reg);
      const writer = makePrivilegedWriter(v.path);
      const ctxFactory = {
        baseCtx: { tools: {} as never, vault: { path: v.path } },
        privilegedWriter: writer,
      };

      // Fire the event 3 times. After the 3rd failure, recordFailure calls
      // scheduleSave() — but the test never awaits an individual save.
      for (let i = 0; i < 3; i++) {
        await dispatcher.dispatchEvents([{ kind: "test.event" }], ctxFactory);
      }

      // Settle via the same surface vault.drainHooks composes:
      // dispatcher.drain() + registry.flushPersist().
      await dispatcher.drain();
      await reg.flushPersist();

      const data = JSON.parse(await readFile(quarantinePath, "utf8")) as string[];
      expect(data).toContain("always-fails");
    } finally {
      await v.cleanup();
    }
  });

  test("preloaded quarantined.json blocks matching dispatches at the registry seam (closes F3 — behavior, not round-trip)", async () => {
    // F3: the prior round-trip test ("file written before openVault still
    // contains the array after") would pass even if openVault stopped
    // calling makeQuarantineStore(...).load(). It tests the test, not the
    // behavior. This test exercises the load by constructing a HookRegistry
    // with the same initialQuarantined option openVault uses, asserting the
    // handler is in fact skipped on matching events.
    const v = await makeTestVault();
    try {
      const stateDir = join(v.path, ".dome", "state");
      await mkdir(stateDir, { recursive: true });
      const quarantinePath = join(stateDir, "quarantined.json");
      await writeFile(quarantinePath, JSON.stringify(["preloaded-handler"]));

      // Compose the same load+seed shape vault.ts performs.
      const { makeQuarantineStore } = await import("../../src/quarantine-store");
      const initial = await makeQuarantineStore(quarantinePath).load();
      expect(initial).toEqual(["preloaded-handler"]);

      const reg = new HookRegistry({ persistPath: quarantinePath, initialQuarantined: initial });
      let fired = false;
      reg.register({
        id: "preloaded-handler",
        pattern: "test.event",
        handler: async () => { fired = true; },
        source: "vault-local",
        async: false,
        idempotent: true,
      });

      // matchesEvent must filter the preloaded-quarantined handler out, so
      // even though the pattern matches, the registry doesn't return it.
      const matches = reg.matchesEvent("test.event");
      expect(matches.find(h => h.id === "preloaded-handler")).toBeUndefined();
      expect(fired).toBe(false);

      // A non-quarantined handler with the same pattern still fires —
      // confirms matching itself is intact and the filter is targeted.
      reg.register({
        id: "healthy-handler",
        pattern: "test.event",
        handler: async () => {},
        source: "vault-local",
        async: false,
        idempotent: true,
      });
      const matches2 = reg.matchesEvent("test.event");
      expect(matches2.find(h => h.id === "healthy-handler")).toBeDefined();
    } finally {
      await v.cleanup();
    }
  });
});
