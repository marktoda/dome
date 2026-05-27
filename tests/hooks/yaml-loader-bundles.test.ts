import { describe, test, expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HookRegistry } from "../../src/hooks/hook-registry";
import { loadDeclarativeHooks } from "../../src/hooks/yaml-loader";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("loadDeclarativeHooks with bundle hooks", () => {
  test("registers a bundle-contributed hook with ID '<bundle>:<filename-stem>'", async () => {
    const v = await makeTestVault();
    try {
      const bundleDir = join(v.path, ".dome", "extensions", "hello-world");
      const bundleHooksDir = join(bundleDir, "hooks");
      await mkdir(bundleHooksDir, { recursive: true });
      await writeFile(
        join(bundleDir, "manifest.yaml"),
        "name: hello-world\nversion: 1.0.0\n",
      );
      await writeFile(
        join(bundleHooksDir, "say-hello.yaml"),
        "event: document.written\nworkflow: ingest\n",
      );

      const vaultResult = await openVault(v.path);
      expect(vaultResult.ok).toBe(true);
      if (!vaultResult.ok) return;
      const vault = vaultResult.value;

      // Re-load declarative hooks into a fresh registry so we can introspect.
      // (vault's internal registry is not exposed by design; bundle hooks
      // get the same code path here.)
      const registry = new HookRegistry();
      await loadDeclarativeHooks(vault, registry, {
        runWorkflow: async () => undefined,
      });
      const ids = registry.list().map((h) => h.id);
      expect(ids).toContain("hello-world:say-hello");
      await vault.close();
    } finally {
      await v.cleanup();
    }
  });

  test("vault-local declarative hooks still register with 'declarative:' prefix (regression)", async () => {
    const v = await makeTestVault();
    try {
      await mkdir(join(v.path, ".dome", "hooks"), { recursive: true });
      await writeFile(
        join(v.path, ".dome", "hooks", "intake-raw.yaml"),
        "event: document.written\npath_pattern: \"inbox/raw/*\"\nworkflow: ingest\n",
      );

      const vaultResult = await openVault(v.path);
      expect(vaultResult.ok).toBe(true);
      if (!vaultResult.ok) return;
      const vault = vaultResult.value;

      const registry = new HookRegistry();
      await loadDeclarativeHooks(vault, registry, {
        runWorkflow: async () => undefined,
      });
      const ids = registry.list().map((h) => h.id);
      expect(ids).toContain("declarative:intake-raw");
      await vault.close();
    } finally {
      await v.cleanup();
    }
  });
});
