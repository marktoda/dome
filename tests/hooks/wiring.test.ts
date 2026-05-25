import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("vault hook wiring (SDK defaults)", () => {
  test("writing a new wiki entity triggers auto-update-index automatically", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const vault = res.value;
      await vault.tools.writeDocument({
        path: "wiki/entities/danny.md",
        body: "# Danny",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      // Async hook may not have run yet; drain.
      await vault.drainHooks();
      const idx = await readFile(join(v.path, "index.md"), "utf8");
      expect(idx).toContain("[[wiki/entities/danny]]");
    } finally {
      await v.cleanup();
    }
  });
});
