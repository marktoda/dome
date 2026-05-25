import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { writeDocument } from "../../src/tools/write-document";
import { makeDispatcher } from "../../src/dispatcher";
import { makeTestVault } from "../helpers/make-test-vault";

describe("WIKILINKS_ARE_FULLPATH", () => {
  test("rejects body with short-form wikilink", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      const out = await writeDocument(vault.value, dispatcher, {
        path: "wiki/entities/danny.md",
        body: "# Danny\n\nSee also [[Maya]] — short form is illegal.",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      expect(out.result.ok).toBe(false);
      if (!out.result.ok) {
        expect(out.result.error.kind).toBe("wikilink-not-fullpath");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("accepts body with full-path wikilinks", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      const out = await writeDocument(vault.value, dispatcher, {
        path: "wiki/entities/danny.md",
        body: "# Danny\n\nSee also [[wiki/entities/maya]].",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      expect(out.result.ok).toBe(true);
    } finally {
      await v.cleanup();
    }
  });
});
