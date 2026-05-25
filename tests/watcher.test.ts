import { describe, test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VaultWatcher } from "../src/watcher";
import { makeTestVault } from "./helpers/make-test-vault";

describe("VaultWatcher", () => {
  test("emits vault.out-of-band-edit on file creation in wiki/", async () => {
    const v = await makeTestVault();
    const events: { kind: string; path: string }[] = [];
    const watcher = new VaultWatcher(v.path, (e) => events.push({ kind: e.kind, path: e.path }));
    await watcher.start();
    try {
      await writeFile(join(v.path, "wiki", "entities", "danny.md"), "---\ntype: entity\n---\n# Danny");
      // chokidar may take a moment to fire on macOS
      await new Promise(r => setTimeout(r, 1000));
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]!.kind).toBe("vault.out-of-band-edit");
    } finally {
      await watcher.stop();
      await v.cleanup();
    }
  });
});
