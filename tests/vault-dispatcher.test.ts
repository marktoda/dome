import { describe, test, expect } from "bun:test";
import { HookRegistry } from "../src/hook-registry";
import { makePrivilegedWriter } from "../src/privileged-writer";
import { wireDispatcher, type VaultRef } from "../src/vault-dispatcher";
import type { Vault } from "../src/vault";
import type { HookEvent, HookContext } from "../src/hook-context";
import { SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES } from "../src/shipped-defaults";
import { makeTempDir, removeTempDir } from "./helpers/temp-dir";

/**
 * Exercises the vaultRef setter pattern. The dispatcher closures must read
 * `vaultRef.current` at call-time, so they tolerate being invoked both
 * before and after the Vault is published into the holder.
 */
describe("wireDispatcher (vaultRef setter pattern)", () => {
  test("dispatchEvents no-ops before vaultRef.current is populated", async () => {
    const root = await makeTempDir("vault-dispatcher-");
    try {
      const registry = new HookRegistry();
      const writer = makePrivilegedWriter(root);
      const vaultRef: VaultRef = { current: null };
      const wired = wireDispatcher(registry, writer, { vaultRef });

      // Empty registry + null vaultRef: dispatchEvents should silently
      // accept the event without throwing or invoking anything.
      await expect(
        wired.dispatchEvents([{ kind: "document.written.wiki.entity", path: "wiki/entities/foo.md" }])
      ).resolves.toBeUndefined();
    } finally {
      await removeTempDir(root);
    }
  });

  test("dispatchEvents reads vaultRef.current at call-time", async () => {
    const root = await makeTempDir("vault-dispatcher-");
    try {
      const registry = new HookRegistry();
      const writer = makePrivilegedWriter(root);
      const vaultRef: VaultRef = { current: null };
      const wired = wireDispatcher(registry, writer, { vaultRef });

      // Register a hook that records the ctx.vault.path it saw — proves the
      // closure observed the published Vault, not a captured-at-wire-time copy.
      const seen: string[] = [];
      registry.register({
        id: "probe",
        pattern: "document.written.wiki.entity",
        async: false,
        idempotent: true,
        source: "sdk",
        handler: async (_e: HookEvent, ctx: HookContext) => {
          seen.push(ctx.vault.path);
        },
      });

      // Publish a Vault stand-in into the ref AFTER wireDispatcher returned.
      // The closure must pick this up at the next dispatchEvents call.
      const stub: Vault = {
        path: root,
        config: SHIPPED_VAULT_CONFIG,
        pageTypes: SHIPPED_PAGE_TYPES,
        tools: {} as Vault["tools"],
        drainHooks: wired.drainHooks,
        dispatchEvents: wired.dispatchEvents,
        rebuildIndex: async () => {},
        close: wired.close,
        _writer: writer,
      };
      vaultRef.current = stub;

      await wired.dispatchEvents([{ kind: "document.written.wiki.entity", path: "wiki/entities/foo.md" }]);
      await wired.drainHooks();
      expect(seen).toEqual([root]);
    } finally {
      await removeTempDir(root);
    }
  });

  test("close() makes subsequent dispatchEvents calls silent no-ops", async () => {
    const root = await makeTempDir("vault-dispatcher-");
    try {
      const registry = new HookRegistry();
      const writer = makePrivilegedWriter(root);
      const vaultRef: VaultRef = { current: null };
      const wired = wireDispatcher(registry, writer, { vaultRef });

      let invocations = 0;
      registry.register({
        id: "probe",
        pattern: "document.written.wiki.entity",
        async: false,
        idempotent: true,
        source: "sdk",
        handler: async () => { invocations++; },
      });

      const stub: Vault = {
        path: root,
        config: SHIPPED_VAULT_CONFIG,
        pageTypes: SHIPPED_PAGE_TYPES,
        tools: {} as Vault["tools"],
        drainHooks: wired.drainHooks,
        dispatchEvents: wired.dispatchEvents,
        rebuildIndex: async () => {},
        close: wired.close,
        _writer: writer,
      };
      vaultRef.current = stub;

      await wired.close();
      await wired.dispatchEvents([{ kind: "document.written.wiki.entity", path: "wiki/entities/foo.md" }]);
      await wired.drainHooks();
      expect(invocations).toBe(0);
    } finally {
      await removeTempDir(root);
    }
  });
});
