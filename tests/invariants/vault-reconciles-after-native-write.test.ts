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

  test("native fs.writeFile + dome reconcile → exactly one out-of-band log entry per file (reconcile leg)", async () => {
    const v = await makeTestVault();
    try {
      const r = await openVault(v.path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const vault = r.value;

      await mkdir(join(vault.path, "wiki", "entities"), { recursive: true });
      await writeFile(
        join(vault.path, "wiki", "entities", "reconcile-target.md"),
        "---\ntype: entity\ncreated: 2026-05-26\nupdated: 2026-05-26\nsources: []\n---\n# Reconcile target\n",
      );

      const { reconcile } = await import("../../src/reconcile");
      await reconcile(vault, { onEvent: (e) => vault.dispatchEvents([e]) });
      await vault.drainHooks();

      const logBody = await readFile(join(vault.path, "log.md"), "utf8");
      // Parse log.md entry lines (## [<ts>] <verb> | <subject>) and count
      // entries naming the target file. Asserts exactly-once per write so
      // a regression that fires the hook on Tool-mediated events too (the
      // shape of the NEW-B1 defect from the prior repair pass) would fail
      // here rather than passing silently on a presence-only check.
      const entryRe = /^## \[[^\]]+\] (\S+) \| (.+)$/gm;
      const entries: { verb: string; subject: string }[] = [];
      for (const m of logBody.matchAll(entryRe)) {
        entries.push({ verb: m[1]!, subject: m[2]! });
      }
      const targetEntries = entries.filter(e => e.subject.includes("wiki/entities/reconcile-target.md"));
      expect(targetEntries.length).toBe(1);
      expect(targetEntries[0]!.subject.toLowerCase()).toContain("out-of-band");
      expect(targetEntries[0]!.subject.toLowerCase()).toContain("reconcile");
    } finally {
      await v.cleanup();
    }
  });

  test("Tool-mediated writeDocument during reconcile produces exactly one log entry (no out-of-band tag, no double-log)", async () => {
    // Regression for NEW-B1: confirms the reconcile leg's appendLog call
    // doesn't fire on Tool-mediated writes. A Tool write inside the same
    // session as reconcile must log once via the Tool's own appended-log
    // effect, with NO "out-of-band, reconcile" entry.
    const v = await makeTestVault();
    try {
      const r = await openVault(v.path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const vault = r.value;

      const writeRes = await vault.tools.writeDocument({
        path: "wiki/entities/tool-write.md",
        body: "# Tool write",
        frontmatter: { type: "entity", created: "2026-05-26", updated: "2026-05-26", sources: [] },
        opts: { create: true, reason: "named_explicitly" },
      });
      expect(writeRes.result.ok).toBe(true);
      await vault.drainHooks();

      const logBody = await readFile(join(vault.path, "log.md"), "utf8");
      const entryRe = /^## \[[^\]]+\] (\S+) \| (.+)$/gm;
      const entries: { verb: string; subject: string }[] = [];
      for (const m of logBody.matchAll(entryRe)) {
        entries.push({ verb: m[1]!, subject: m[2]! });
      }
      const toolEntries = entries.filter(e => e.subject.includes("wiki/entities/tool-write.md"));
      expect(toolEntries.length).toBe(1);
      // Tool writes must NOT carry the "out-of-band" tag — that's the
      // external-path enforcement tag, not the Tool path's.
      expect(toolEntries[0]!.subject.toLowerCase()).not.toContain("out-of-band");
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
