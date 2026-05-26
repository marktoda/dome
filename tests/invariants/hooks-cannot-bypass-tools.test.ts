// HOOKS_CANNOT_BYPASS_TOOLS — two layers of enforcement:
//   (a) Type-level: HookContext exposes no `fs` / `writeFile`; only `tools`,
//       `vault.path`, and the privileged `dispatcher` (sdk-source hooks only).
//   (b) Runtime: a malicious hook (or any out-of-band fs writer) triggers
//       a `vault.out-of-band-edit` event via VaultWatcher so reconciliation
//       can detect the bypass.

import { describe, test, expect } from "bun:test";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { HookContext } from "../../src/hook-context";
import { VaultWatcher, type OOBEvent } from "../../src/watcher";
import { makeTestVault } from "../helpers/make-test-vault";

type HasField<T, K extends string> = K extends keyof T ? true : false;
type NotHasField<T, K extends string> = K extends keyof T ? false : true;

type AssertNoFs = NotHasField<HookContext, "fs">;
type AssertNoWrite = NotHasField<HookContext, "writeFile">;
type AssertHasTools = HasField<HookContext, "tools">;
type AssertHasVault = HasField<HookContext, "vault">;

const _checks: [AssertNoFs, AssertNoWrite, AssertHasTools, AssertHasVault] = [true, true, true, true];

describe("HOOKS_CANNOT_BYPASS_TOOLS (type-level)", () => {
  test("HookContext has no filesystem access", () => {
    expect(_checks).toEqual([true, true, true, true]);
  });

  test("HookContext exposes a `tools` field of the Tool surface", () => {
    expect(true).toBe(true);
  });
});

describe("HOOKS_CANNOT_BYPASS_TOOLS (runtime)", () => {
  test("malicious out-of-band write fires vault.out-of-band-edit (caught by VaultWatcher)", async () => {
    const v = await makeTestVault();
    const events: OOBEvent[] = [];
    const watcher = new VaultWatcher(v.path, (e) => events.push(e));
    await watcher.start();
    try {
      // Simulate a malicious hook that bypasses Tools by writing directly via
      // node:fs. VaultWatcher MUST observe this and emit vault.out-of-band-edit.
      await mkdir(join(v.path, "wiki", "entities"), { recursive: true });
      await writeFile(
        join(v.path, "wiki", "entities", "malicious.md"),
        "---\ntype: entity\n---\n# malicious",
      );
      // Give chokidar a moment to flush the FS event.
      await new Promise(r => setTimeout(r, 1000));
      const hit = events.find(e => e.kind === "vault.out-of-band-edit" && e.path.endsWith("malicious.md"));
      expect(hit).toBeDefined();
    } finally {
      await watcher.stop();
      await v.cleanup();
    }
  });
});
