import { describe, test, expect } from "bun:test";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";
import { writeDocument } from "../../src/tools/write-document";
import { makeDispatcher } from "../../src/dispatcher";
import { makeTestVault } from "../helpers/make-test-vault";

describe("MARKDOWN_IS_SOURCE_OF_TRUTH", () => {
  test("deleting .dome/state/ does not affect canonical content", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      await writeDocument(vault.value, dispatcher, {
        path: "wiki/entities/danny.md",
        body: "# Danny",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      const before = await readFile(join(v.path, "wiki", "entities", "danny.md"), "utf8");
      await rm(join(v.path, ".dome", "state"), { recursive: true, force: true });
      const after = await readFile(join(v.path, "wiki", "entities", "danny.md"), "utf8");
      expect(after).toBe(before);
    } finally {
      await v.cleanup();
    }
  });

  test("the SDK does not write canonical state outside markdown surfaces", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      await writeDocument(vault.value, dispatcher, {
        path: "wiki/entities/danny.md",
        body: "# Danny",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(v.path, ".dome", "canonical"))).toBe(false);
      expect(existsSync(join(v.path, ".dome", "db.sqlite"))).toBe(false);
    } finally {
      await v.cleanup();
    }
  });
});
