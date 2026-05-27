import { describe, test, expect } from "bun:test";
import { mkdir, rm, writeFile, cp } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

const HELLO_WORLD_FIXTURE = join(import.meta.dir, "../fixtures/extensions/hello-world");

describe("extension bundle end-to-end load", () => {
  test("hello-world fixture loads cleanly: page type, preamble, workflow, hook all register", async () => {
    const v = await makeTestVault();
    try {
      await mkdir(join(v.path, ".dome", "extensions"), { recursive: true });
      await cp(HELLO_WORLD_FIXTURE, join(v.path, ".dome", "extensions", "hello-world"), {
        recursive: true,
      });

      const vaultResult = await openVault(v.path);
      expect(vaultResult.ok).toBe(true);
      if (!vaultResult.ok) return;
      const vault = vaultResult.value;

      // Page type 'hello' is in PageTypesConfig.extensions.
      const extensionNames = vault.pageTypes.extensions.map((e) =>
        typeof e === "string" ? e : e.name,
      );
      expect(extensionNames).toContain("hello");

      // Bundle is in vault.bundles.
      const bundleNames = vault.bundles.map((b) => b.name);
      expect(bundleNames).toContain("hello-world");

      await vault.close();
    } finally {
      await v.cleanup();
    }
  });

  test("two bundles with colliding page-type names reject openVault", async () => {
    const v = await makeTestVault();
    try {
      for (const bn of ["alpha-bundle", "zebra-bundle"]) {
        const dir = join(v.path, ".dome", "extensions", bn);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "manifest.yaml"), `name: ${bn}\nversion: 1.0.0\n`);
        await writeFile(join(dir, "page-types.yaml"), "extensions:\n  - name: shared\n");
      }
      const vaultResult = await openVault(v.path);
      expect(vaultResult.ok).toBe(false);
      if (!vaultResult.ok && vaultResult.error.kind === "bundle-load-failure") {
        expect(vaultResult.error.detail).toBe("page-type-collision");
        expect(vaultResult.error.message).toContain("shared");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("bundle removal between openVault calls clears registrations", async () => {
    const v = await makeTestVault();
    try {
      await mkdir(join(v.path, ".dome", "extensions"), { recursive: true });
      await cp(HELLO_WORLD_FIXTURE, join(v.path, ".dome", "extensions", "hello-world"), {
        recursive: true,
      });

      let result = await openVault(v.path);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const names = result.value.pageTypes.extensions.map((e) =>
          typeof e === "string" ? e : e.name,
        );
        expect(names).toContain("hello");
        await result.value.close();
      }

      await rm(join(v.path, ".dome", "extensions", "hello-world"), { recursive: true });

      result = await openVault(v.path);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const names = result.value.pageTypes.extensions.map((e) =>
          typeof e === "string" ? e : e.name,
        );
        expect(names).not.toContain("hello");
        await result.value.close();
      }
    } finally {
      await v.cleanup();
    }
  });

  test("malformed manifest rejects openVault with manifest-invalid detail", async () => {
    const v = await makeTestVault();
    try {
      const dir = join(v.path, ".dome", "extensions", "broken");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "manifest.yaml"), "missing-name-field: true\n");
      const result = await openVault(v.path);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "bundle-load-failure") {
        expect(result.error.detail).toBe("manifest-invalid");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("bundle directory without manifest.yaml rejects openVault", async () => {
    const v = await makeTestVault();
    try {
      const dir = join(v.path, ".dome", "extensions", "orphan");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "preamble.md"), "lonely\n");
      const result = await openVault(v.path);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "bundle-load-failure") {
        expect(result.error.detail).toBe("manifest-missing");
      }
    } finally {
      await v.cleanup();
    }
  });
});
