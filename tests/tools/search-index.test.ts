import { describe, test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";
import { searchIndex } from "../../src/tools/search-index";
import { makeTestVault } from "../helpers/make-test-vault";

describe("searchIndex", () => {
  test("finds matches across wiki pages", async () => {
    const v = await makeTestVault();
    try {
      await writeFile(join(v.path, "wiki", "entities", "danny.md"), "---\ntype: entity\n---\n# Danny\n\nWorks on platform team.");
      await writeFile(join(v.path, "wiki", "entities", "maya.md"), "---\ntype: entity\n---\n# Maya\n\nLeads design.");
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const out = await searchIndex(vault.value, { query: "platform" });
      expect(out.result.ok).toBe(true);
      if (out.result.ok) {
        expect(out.result.value.length).toBeGreaterThanOrEqual(1);
        expect(out.result.value[0]!.path).toContain("danny.md");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("filters by type", async () => {
    const v = await makeTestVault();
    try {
      await writeFile(join(v.path, "wiki", "entities", "danny.md"), "---\ntype: entity\n---\n# Danny\nteam");
      await writeFile(join(v.path, "wiki", "concepts", "team.md"), "---\ntype: concept\n---\n# Team\nteam");
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const out = await searchIndex(vault.value, { query: "team", filters: { type: "concept" } });
      expect(out.result.ok).toBe(true);
      if (out.result.ok) {
        expect(out.result.value.every(m => m.path.includes("concepts/"))).toBe(true);
      }
    } finally {
      await v.cleanup();
    }
  });
});
