import { describe, test, expect } from "bun:test";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";
import { VaultWatcher } from "../../src/watcher";
import { logOutOfBandWrite } from "../../src/hooks/log-out-of-band-write";
import type { HookContext } from "../../src/hook-context";
import { makeTestVault } from "../helpers/make-test-vault";

describe("VAULT_RECONCILES_AFTER_NATIVE_WRITE", () => {
  test("the shipped-default log-out-of-band-write hook records native writes via appendLog", async () => {
    const calls: Array<{ verb: string; subject: string }> = [];
    const ctx = {
      tools: {
        appendLog: async (input: { verb: string; subject: string }) => {
          calls.push(input);
          return { result: { ok: true, value: {} as never }, effects: [] };
        },
      },
    } as unknown as HookContext;

    await logOutOfBandWrite(
      { kind: "vault.out-of-band-edit", path: "wiki/entities/danny.md", fsKind: "modified" } as never,
      ctx,
    );

    expect(calls.length).toBe(1);
    expect(calls[0]!.subject).toContain("wiki/entities/danny.md");
    expect(calls[0]!.subject.toLowerCase()).toContain("out-of-band");
  });

  test("native fs.writeFile + dome reconcile → log.md gains an out-of-band entry via the shipped-default hook", async () => {
    const v = await makeTestVault();
    try {
      const r = await openVault(v.path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const vault = r.value;

      // Write a wiki file directly via node:fs (bypasses Tools, no watcher).
      await mkdir(join(vault.path, "wiki", "entities"), { recursive: true });
      await writeFile(
        join(vault.path, "wiki", "entities", "reconcile-target.md"),
        "---\ntype: entity\ncreated: 2026-05-26\nupdated: 2026-05-26\nsources: []\n---\n# Reconcile target\n",
      );

      // Run reconcile — phase 2 detects the working-tree change and fires
      // document.written.wiki.entity, which the shipped-default
      // log-out-of-band-write hook subscribes to.
      const { reconcile } = await import("../../src/reconcile");
      await reconcile(vault, { onEvent: (e) => vault.dispatchEvents([e]) });
      await vault.drainHooks();

      const logBody = await readFile(join(vault.path, "log.md"), "utf8");
      expect(logBody).toContain("wiki/entities/reconcile-target.md");
      expect(logBody.toLowerCase()).toContain("out-of-band");
    } finally {
      await v.cleanup();
    }
  });

  test("native fs.writeFile + VaultWatcher → log.md gains an out-of-band entry via the shipped-default hook", async () => {
    const v = await makeTestVault();
    try {
      const r = await openVault(v.path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const vault = r.value;

      const watcher = new VaultWatcher(vault.path, (event) => {
        void vault.dispatchEvents([event]);
      });
      await watcher.start();

      try {
        await mkdir(join(vault.path, "wiki", "entities"), { recursive: true });
        await writeFile(
          join(vault.path, "wiki", "entities", "test.md"),
          "---\ntype: entity\ncreated: 2026-05-26\nupdated: 2026-05-26\nsources: []\n---\n# Test\n",
        );
        await new Promise(r => setTimeout(r, 1200));
        await vault.drainHooks();

        const logBody = await readFile(join(vault.path, "log.md"), "utf8");
        expect(logBody).toContain("wiki/entities/test.md");
        expect(logBody.toLowerCase()).toContain("out-of-band");
      } finally {
        await watcher.stop();
      }
    } finally {
      await v.cleanup();
    }
  });
});
