// End-to-end: create a wiki page, drain hooks, assert index.md has an entry;
// delete the page via the Tool, drain again, assert the entry is gone.

import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("auto-update-index — delete branch", () => {
  test("deleting a wiki page removes its index entry", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const vault = res.value;

      const created = await vault.tools.writeDocument({
        path: "wiki/entities/danny.md",
        body: "# Danny\n",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      expect(created.result.ok).toBe(true);
      await vault.drainHooks();

      const beforeIdx = await readFile(join(v.path, "index.md"), "utf8");
      expect(beforeIdx).toContain("[[wiki/entities/danny]]");

      const deleted = await vault.tools.deleteDocument({
        path: "wiki/entities/danny.md",
        reason: "test",
      });
      expect(deleted.result.ok).toBe(true);
      await vault.drainHooks();

      const afterIdx = await readFile(join(v.path, "index.md"), "utf8");
      expect(afterIdx).not.toContain("[[wiki/entities/danny]]");
    } finally {
      await v.cleanup();
    }
  });
});
