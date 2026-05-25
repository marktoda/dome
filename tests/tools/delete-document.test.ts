import { describe, test, expect } from "bun:test";
import { writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";
import { deleteDocument } from "../../src/tools/delete-document";
import { makeDispatcher } from "../../src/dispatcher";
import { makeTestVault } from "../helpers/make-test-vault";

describe("deleteDocument", () => {
  test("deletes a wiki page", async () => {
    const v = await makeTestVault();
    try {
      const filePath = join(v.path, "wiki", "entities", "danny.md");
      await writeFile(filePath, "---\ntype: entity\n---\n# Danny");
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      const out = await deleteDocument(vault.value, dispatcher, {
        path: "wiki/entities/danny.md",
        reason: "obsolete",
      });
      expect(out.result.ok).toBe(true);
      await expect(access(filePath)).rejects.toThrow();
    } finally {
      await v.cleanup();
    }
  });

  test("refuses raw/ path", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      const out = await deleteDocument(vault.value, dispatcher, {
        path: "raw/abc.md",
        reason: "x",
      });
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) {
        expect(out.result.error.kind).toBe("invariant-violated");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("refuses index.md", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      const out = await deleteDocument(vault.value, dispatcher, {
        path: "index.md",
        reason: "x",
      });
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) {
        expect(out.result.error.kind).toBe("dispatcher-owned-path");
      }
    } finally {
      await v.cleanup();
    }
  });
});
