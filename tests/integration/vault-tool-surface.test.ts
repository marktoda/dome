import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("Vault.tools surface", () => {
  test("openVault returns a Vault whose .tools has all 7 Tools bound", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const vault = res.value;
      expect(typeof vault.tools.readDocument).toBe("function");
      expect(typeof vault.tools.writeDocument).toBe("function");
      expect(typeof vault.tools.appendLog).toBe("function");
      expect(typeof vault.tools.searchIndex).toBe("function");
      expect(typeof vault.tools.wikilinkResolve).toBe("function");
      expect(typeof vault.tools.moveDocument).toBe("function");
      expect(typeof vault.tools.deleteDocument).toBe("function");
    } finally {
      await v.cleanup();
    }
  });

  test("vault.tools.writeDocument enforces invariants without needing dispatcher passed by caller", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const vault = res.value;
      const out = await vault.tools.writeDocument({
        path: "wiki/entities/danny.md",
        body: "# Danny",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      expect(out.result.ok).toBe(true);
    } finally {
      await v.cleanup();
    }
  });
});
