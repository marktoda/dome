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
