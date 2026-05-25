import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";
import { writeDocument } from "../../src/tools/write-document";
import { makeDispatcher } from "../../src/dispatcher";
import { makeTestVault } from "../helpers/make-test-vault";

describe("writeDocument — basic create/update", () => {
  test("creates a new wiki page", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) throw new Error("openVault failed");
      const dispatcher = makeDispatcher(v.path);
      const out = await writeDocument(vault.value, dispatcher, {
        path: "wiki/entities/maya.md",
        body: "# Maya\n",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      expect(out.result.ok).toBe(true);
      const onDisk = await readFile(join(v.path, "wiki", "entities", "maya.md"), "utf8");
      expect(onDisk).toContain("type: entity");
      expect(onDisk).toContain("# Maya");
    } finally {
      await v.cleanup();
    }
  });

  test("returns already-exists when create: true on an existing path", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      const fm = { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] };
      await writeDocument(vault.value, dispatcher, {
        path: "wiki/entities/maya.md",
        body: "# Maya\n",
        frontmatter: fm,
        opts: { create: true },
      });
      const out = await writeDocument(vault.value, dispatcher, {
        path: "wiki/entities/maya.md",
        body: "# Maya v2\n",
        frontmatter: fm,
        opts: { create: true },
      });
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) {
        expect(out.result.error.kind).toBe("already-exists");
      }
    } finally {
      await v.cleanup();
    }
  });
});
