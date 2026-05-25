import { describe, test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";
import { readDocument } from "../../src/tools/read-document";
import { makeTestVault } from "../helpers/make-test-vault";

describe("readDocument", () => {
  test("reads a wiki page with frontmatter and body", async () => {
    const v = await makeTestVault();
    try {
      const filePath = join(v.path, "wiki", "entities", "danny.md");
      await writeFile(filePath, `---
type: entity
created: 2026-05-01
updated: 2026-05-25
sources: []
---

# Danny

A person.
See also [[wiki/entities/maya]].
`);
      const vault = await openVault(v.path);
      if (!vault.ok) throw new Error("openVault failed");
      const out = await readDocument(vault.value, { path: "wiki/entities/danny.md" });
      expect(out.result.ok).toBe(true);
      if (!out.result.ok) return;
      const doc = out.result.value;
      expect(doc.path).toBe("wiki/entities/danny.md");
      expect(doc.frontmatter.type).toBe("entity");
      expect(doc.body).toContain("# Danny");
      expect(doc.linksOut.length).toBe(1);
      expect(doc.linksOut[0]!.target).toBe("wiki/entities/maya");
      expect(doc.category).toBe("wiki");
      expect(doc.type).toBe("entities");
    } finally {
      await v.cleanup();
    }
  });

  test("returns not-found for a missing path", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const out = await readDocument(vault.value, { path: "wiki/entities/missing.md" });
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) {
        expect(out.result.error.kind).toBe("not-found");
      }
    } finally {
      await v.cleanup();
    }
  });
});
