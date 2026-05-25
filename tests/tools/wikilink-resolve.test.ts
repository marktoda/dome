import { describe, test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";
import { wikilinkResolve } from "../../src/tools/wikilink-resolve";
import { makeTestVault } from "../helpers/make-test-vault";

describe("wikilinkResolve", () => {
  test("resolves a valid full-path wikilink", async () => {
    const v = await makeTestVault();
    try {
      await writeFile(join(v.path, "wiki", "entities", "danny.md"), "---\ntype: entity\n---\n# Danny");
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const out = await wikilinkResolve(vault.value, { link: "wiki/entities/danny" });
      expect(out.result.ok).toBe(true);
      if (out.result.ok) {
        expect(out.result.value?.path).toBe("wiki/entities/danny.md");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("returns null for short-form link", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const out = await wikilinkResolve(vault.value, { link: "Danny" });
      expect(out.result.ok).toBe(true);
      if (out.result.ok) {
        expect(out.result.value).toBeNull();
      }
    } finally {
      await v.cleanup();
    }
  });

  test("returns null for missing target", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const out = await wikilinkResolve(vault.value, { link: "wiki/entities/nonexistent" });
      expect(out.result.ok).toBe(true);
      if (out.result.ok) {
        expect(out.result.value).toBeNull();
      }
    } finally {
      await v.cleanup();
    }
  });
});
