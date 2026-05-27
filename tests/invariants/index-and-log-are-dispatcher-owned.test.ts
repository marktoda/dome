import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { writeDocument } from "../../src/tools/write-document";
import { moveDocument } from "../../src/tools/move-document";
import { deleteDocument } from "../../src/tools/delete-document";
import { makePrivilegedWriter } from "../../src/privileged-writer";
import { HookRegistry } from "../../src/hooks/hook-registry";
import { HookDispatcher } from "../../src/hooks/hook-dispatcher";
import { makeTestVault } from "../helpers/make-test-vault";
import type { HookContext } from "../../src/hooks/hook-context";

describe("INDEX_AND_LOG_ARE_DISPATCHER_OWNED", () => {
  test("writeDocument rejects index.md with dispatcher-owned-path", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makePrivilegedWriter(v.path);
      const out = await writeDocument(vault.value, dispatcher, {
        path: "index.md",
        body: "# Bogus",
        frontmatter: {},
        opts: { create: false },
      });
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) {
        expect(out.result.error.kind).toBe("dispatcher-owned-path");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("writeDocument rejects log.md with dispatcher-owned-path", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makePrivilegedWriter(v.path);
      const out = await writeDocument(vault.value, dispatcher, {
        path: "log.md",
        body: "Bogus log",
        frontmatter: {},
        opts: { create: false },
      });
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) {
        expect(out.result.error.kind).toBe("dispatcher-owned-path");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("moveDocument rejects index.md and log.md (matrix-mandated)", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makePrivilegedWriter(v.path);
      const out1 = await moveDocument(vault.value, dispatcher, {
        from: "index.md",
        to: "wiki/syntheses/index.md",
        reason: "bogus",
      });
      expect(out1.result.ok).toBe(false);
      if (!out1.result.ok) expect(out1.result.error.kind).toBe("dispatcher-owned-path");

      const out2 = await moveDocument(vault.value, dispatcher, {
        from: "log.md",
        to: "wiki/notes/log.md",
        reason: "bogus",
      });
      expect(out2.result.ok).toBe(false);
      if (!out2.result.ok) expect(out2.result.error.kind).toBe("dispatcher-owned-path");
    } finally {
      await v.cleanup();
    }
  });

  test("deleteDocument rejects index.md and log.md (matrix-mandated)", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makePrivilegedWriter(v.path);
      const out1 = await deleteDocument(vault.value, dispatcher, {
        path: "index.md",
        reason: "bogus",
      });
      expect(out1.result.ok).toBe(false);
      if (!out1.result.ok) expect(out1.result.error.kind).toBe("dispatcher-owned-path");

      const out2 = await deleteDocument(vault.value, dispatcher, {
        path: "log.md",
        reason: "bogus",
      });
      expect(out2.result.ok).toBe(false);
      if (!out2.result.ok) expect(out2.result.error.kind).toBe("dispatcher-owned-path");
    } finally {
      await v.cleanup();
    }
  });

  test("HookContext.dispatcher is partitioned by hook.source (B3)", async () => {
    // Capture the ctx each hook handler sees.
    const captured: Record<string, HookContext> = {};
    const reg = new HookRegistry();
    reg.register({
      id: "sdk-hook", pattern: "*", source: "sdk", async: false, idempotent: true,
      handler: async (_ev, ctx) => { captured["sdk"] = ctx; },
    });
    reg.register({
      id: "plugin-hook", pattern: "*", source: "plugin", async: false, idempotent: true,
      handler: async (_ev, ctx) => { captured["plugin"] = ctx; },
    });
    reg.register({
      id: "vault-local-hook", pattern: "*", source: "vault-local", async: false, idempotent: true,
      handler: async (_ev, ctx) => { captured["vault-local"] = ctx; },
    });

    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const privilegedWriter = makePrivilegedWriter(v.path);
      const hookDispatcher = new HookDispatcher(reg);
      await hookDispatcher.dispatchEvents([{ kind: "test.event" }], {
        baseCtx: { tools: vault.value.tools, vault: { path: vault.value.path } },
        privilegedWriter,
      });
      // sdk-source hook receives the privileged writer; plugin & vault-local don't.
      expect(captured["sdk"]?.privilegedWriter).toBeDefined();
      expect(captured["plugin"]?.privilegedWriter).toBeUndefined();
      expect(captured["vault-local"]?.privilegedWriter).toBeUndefined();
    } finally {
      await v.cleanup();
    }
  });
});
