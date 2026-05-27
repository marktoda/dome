import { describe, test, expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadVaultConfig } from "../src/vault-config";
import { SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, shippedConfigYaml, shippedPageTypesYaml } from "../src/shipped-defaults";
import { makeTempDir, removeTempDir } from "./helpers/temp-dir";

describe("loadVaultConfig", () => {
  test("returns shipped defaults when .dome/ has the shipped YAMLs", async () => {
    const root = await makeTempDir("vault-config-");
    try {
      await mkdir(join(root, ".dome"), { recursive: true });
      await writeFile(join(root, ".dome", "config.yaml"), shippedConfigYaml());
      await writeFile(join(root, ".dome", "page-types.yaml"), shippedPageTypesYaml());
      const result = await loadVaultConfig(root);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.value.config).toEqual(SHIPPED_VAULT_CONFIG);
      expect(result.value.pageTypes).toEqual(SHIPPED_PAGE_TYPES);
    } finally {
      await removeTempDir(root);
    }
  });

  test("surfaces a config-invalid error when .dome/config.yaml is missing", async () => {
    const root = await makeTempDir("vault-config-");
    try {
      // No .dome/config.yaml on disk — readFile will throw and we expect the
      // `config-invalid` translation that openVault has historically emitted.
      const result = await loadVaultConfig(root);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.kind).toBe("config-invalid");
    } finally {
      await removeTempDir(root);
    }
  });

  test("falls back to shipped page-types when only page-types.yaml is absent", async () => {
    const root = await makeTempDir("vault-config-");
    try {
      await mkdir(join(root, ".dome"), { recursive: true });
      await writeFile(join(root, ".dome", "config.yaml"), shippedConfigYaml());
      // Deliberately do not write page-types.yaml.
      const result = await loadVaultConfig(root);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.value.pageTypes).toEqual(SHIPPED_PAGE_TYPES);
    } finally {
      await removeTempDir(root);
    }
  });
});

describe("loadVaultConfig with extension bundles", () => {
  test("merges bundle page-types into PageTypesConfig.extensions", async () => {
    const root = await makeTempDir("vault-config-bundle-");
    try {
      await mkdir(join(root, ".dome"), { recursive: true });
      await writeFile(join(root, ".dome", "config.yaml"), shippedConfigYaml());

      const bundleDir = join(root, ".dome/extensions/hello-world");
      await mkdir(bundleDir, { recursive: true });
      await writeFile(join(bundleDir, "manifest.yaml"), "name: hello-world\nversion: 1.0.0\n");
      await writeFile(join(bundleDir, "page-types.yaml"), "extensions:\n  - name: hello\n");

      const r = await loadVaultConfig(root);
      expect(r.ok).toBe(true);
      if (r.ok) {
        const names = r.value.pageTypes.extensions.map((e) =>
          typeof e === "string" ? e : e.name,
        );
        expect(names).toContain("hello");
      }
    } finally {
      await removeTempDir(root);
    }
  });

  test("rejects cross-bundle page-type collision", async () => {
    const root = await makeTempDir("vault-config-bundle-");
    try {
      await mkdir(join(root, ".dome"), { recursive: true });
      await writeFile(join(root, ".dome", "config.yaml"), shippedConfigYaml());

      for (const bn of ["a-bundle", "b-bundle"]) {
        const dir = join(root, ".dome/extensions", bn);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "manifest.yaml"), `name: ${bn}\nversion: 1.0.0\n`);
        await writeFile(join(dir, "page-types.yaml"), "extensions:\n  - name: shared\n");
      }
      const r = await loadVaultConfig(root);
      expect(r.ok).toBe(false);
      if (!r.ok && r.error.kind === "bundle-load-failure") {
        expect(r.error.detail).toBe("page-type-collision");
      }
    } finally {
      await removeTempDir(root);
    }
  });
});
