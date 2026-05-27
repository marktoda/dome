import { describe, test, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildBuiltinHookRegistry } from "../src/vault-hooks";
import { SHIPPED_VAULT_CONFIG } from "../src/shipped-defaults";
import type { VaultConfig } from "../src/vault";
import { makeTempDir, removeTempDir } from "./helpers/temp-dir";

describe("buildBuiltinHookRegistry", () => {
  test("registers the shipped-default handlers when SHIPPED_VAULT_CONFIG is used", async () => {
    const root = await makeTempDir("vault-hooks-");
    try {
      await mkdir(join(root, ".dome", "state"), { recursive: true });
      const registry = await buildBuiltinHookRegistry(root, SHIPPED_VAULT_CONFIG);
      const ids = registry.list().map(h => h.id);
      // SHIPPED_VAULT_CONFIG enables auto-update-index (3 registrations),
      // auto-cross-reference (1), and log-out-of-band-write (1) — five hooks.
      expect(ids).toContain("auto-update-index-write");
      expect(ids).toContain("auto-update-index-delete");
      expect(ids).toContain("auto-update-index-oob");
      expect(ids).toContain("auto-cross-reference");
      expect(ids).toContain("log-out-of-band-write");
      expect(ids.length).toBe(5);
    } finally {
      await removeTempDir(root);
    }
  });

  test("respects per-handler disable flags", async () => {
    const root = await makeTempDir("vault-hooks-");
    try {
      await mkdir(join(root, ".dome", "state"), { recursive: true });
      const config: VaultConfig = {
        ...SHIPPED_VAULT_CONFIG,
        hooks: {
          ...SHIPPED_VAULT_CONFIG.hooks,
          builtin: {
            "auto-update-index": "enabled",
            "auto-cross-reference": "disabled",
            "log-out-of-band-write": "disabled",
          },
        },
      };
      const registry = await buildBuiltinHookRegistry(root, config);
      const ids = registry.list().map(h => h.id);
      expect(ids).toContain("auto-update-index-write");
      expect(ids).not.toContain("auto-cross-reference");
      expect(ids).not.toContain("log-out-of-band-write");
    } finally {
      await removeTempDir(root);
    }
  });
});
