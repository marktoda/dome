import { describe, test, expect } from "bun:test";
import { writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";
import { moveDocument } from "../../src/tools/move-document";
import { makePrivilegedWriter } from "../../src/privileged-writer";
import { makeTestVault } from "../helpers/make-test-vault";

describe("moveDocument", () => {
  test("moves a page and rewrites incoming wikilinks", async () => {
    const v = await makeTestVault();
    try {
      await writeFile(join(v.path, "wiki", "entities", "danny.md"), `---
type: entity
created: 2026-05-01
updated: 2026-05-25
sources: []
---

# Danny`);
      await writeFile(join(v.path, "wiki", "entities", "maya.md"), `---
type: entity
created: 2026-05-01
updated: 2026-05-25
sources: []
---

# Maya

References [[wiki/entities/danny]].`);

      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makePrivilegedWriter(v.path);
      const out = await moveDocument(vault.value, dispatcher, {
        from: "wiki/entities/danny.md",
        to: "wiki/entities/daniel.md",
        reason: "rename to canonical form",
      });
      expect(out.result.ok).toBe(true);
      await access(join(v.path, "wiki", "entities", "daniel.md"));
      await expect(access(join(v.path, "wiki", "entities", "danny.md"))).rejects.toThrow();
      const maya = await readFile(join(v.path, "wiki", "entities", "maya.md"), "utf8");
      expect(maya).toContain("[[wiki/entities/daniel]]");
      expect(maya).not.toContain("[[wiki/entities/danny]]");
    } finally {
      await v.cleanup();
    }
  });

  test("refuses raw/ source", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makePrivilegedWriter(v.path);
      const out = await moveDocument(vault.value, dispatcher, {
        from: "raw/abc.md",
        to: "raw/def.md",
        reason: "x",
      });
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) {
        expect(out.result.error.kind).toBe("invariant-violated");
        if (out.result.error.kind === "invariant-violated") {
          expect(out.result.error.invariant).toBe("RAW_IS_IMMUTABLE");
        }
      }
    } finally {
      await v.cleanup();
    }
  });

  test("refuses index.md / log.md", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makePrivilegedWriter(v.path);
      const out = await moveDocument(vault.value, dispatcher, {
        from: "index.md",
        to: "wiki/syntheses/index.md",
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
