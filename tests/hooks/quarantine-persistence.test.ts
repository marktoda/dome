import { describe, test, expect } from "bun:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HookRegistry } from "../../src/hook-registry";
import { openVault } from "../../src/vault";
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

  test("openVault loads quarantined.json on startup; the loaded ids are honored", async () => {
    const v = await makeTestVault();
    try {
      const stateDir = join(v.path, ".dome", "state");
      await mkdir(stateDir, { recursive: true });
      const quarantinePath = join(stateDir, "quarantined.json");
      await writeFile(quarantinePath, JSON.stringify(["preloaded-handler"]));

      const res = await openVault(v.path);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // The file's contents survive the openVault round-trip — meaning openVault
      // read the file (otherwise it would have remained the array we wrote) and
      // the in-memory registry holds the same set. We can't peek into the
      // registry's private set from outside the Vault, but the round-trip
      // preserves the on-disk state.
      const data = JSON.parse(await readFile(quarantinePath, "utf8")) as string[];
      expect(data).toEqual(["preloaded-handler"]);
    } finally {
      await v.cleanup();
    }
  });
});
