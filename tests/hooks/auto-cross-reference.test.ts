import { describe, test, expect } from "bun:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { autoCrossReference } from "../../src/hooks/auto-cross-reference";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("auto-cross-reference hook", () => {
  test("adds backlinks where the new entity name appears verbatim", async () => {
    const v = await makeTestVault();
    try {
      // Seed an existing page that mentions Danny by name.
      await writeFile(join(v.path, "wiki", "concepts", "platform.md"), `---
type: concept
created: 2026-05-25
updated: 2026-05-25
sources: []
---

# Platform

Danny is the engineering lead.`);

      const res = await openVault(v.path);
      if (!res.ok) return;
      const vault = res.value;
      // Create the entity page first via Tool to avoid OOB.
      await vault.tools.writeDocument({
        path: "wiki/entities/Danny.md",
        body: "# Danny\n",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      const ctx = {
        tools: vault.tools,
        vault: { path: vault.path },
      };
      await autoCrossReference({
        kind: "document.written.wiki.entity",
        path: "wiki/entities/Danny.md",
        category: "wiki",
        type: "entity",
      }, ctx);
      const platform = await readFile(join(v.path, "wiki", "concepts", "platform.md"), "utf8");
      expect(platform).toContain("[[wiki/entities/Danny]]");
    } finally {
      await v.cleanup();
    }
  });

  test("idempotent: second run adds no new links", async () => {
    const v = await makeTestVault();
    try {
      await writeFile(join(v.path, "wiki", "concepts", "platform.md"), `---
type: concept
created: 2026-05-25
updated: 2026-05-25
sources: []
---

# Platform

Maya leads design.`);

      const res = await openVault(v.path);
      if (!res.ok) return;
      const vault = res.value;
      await vault.tools.writeDocument({
        path: "wiki/entities/Maya.md",
        body: "# Maya\n",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      const ctx = {
        tools: vault.tools,
        vault: { path: vault.path },
      };
      const event = {
        kind: "document.written.wiki.entity",
        path: "wiki/entities/Maya.md",
        category: "wiki",
        type: "entity",
      };
      await autoCrossReference(event, ctx);
      const first = await readFile(join(v.path, "wiki", "concepts", "platform.md"), "utf8");
      await autoCrossReference(event, ctx);
      const second = await readFile(join(v.path, "wiki", "concepts", "platform.md"), "utf8");
      expect(second).toBe(first); // idempotent
    } finally {
      await v.cleanup();
    }
  });
});
