import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { writeDocument } from "../../src/tools/write-document";
import { makeDispatcher } from "../../src/dispatcher";
import { makeTestVault } from "../helpers/make-test-vault";

describe("EVERY_WRITE_IS_LOGGED", () => {
  test("writeDocument emits an appended-log effect when enabled", async () => {
    const v = await makeTestVault();
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      const out = await writeDocument(vault.value, dispatcher, {
        path: "wiki/entities/danny.md",
        body: "# Danny",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      expect(out.result.ok).toBe(true);
      const logEffects = out.effects.filter(e => e.kind === "appended-log");
      expect(logEffects.length).toBeGreaterThanOrEqual(1);
    } finally {
      await v.cleanup();
    }
  });

  test("writeDocument skips appendLog effect when disabled", async () => {
    const customConfig = `invariants:
  EVERY_WRITE_IS_LOGGED: disabled
  PAGE_TYPE_BY_DIRECTORY: enabled
  WIKILINKS_ARE_FULLPATH: enabled
`;
    const v = await makeTestVault({ config: customConfig });
    try {
      const vault = await openVault(v.path);
      if (!vault.ok) return;
      const dispatcher = makeDispatcher(v.path);
      const out = await writeDocument(vault.value, dispatcher, {
        path: "wiki/entities/danny.md",
        body: "# Danny",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      expect(out.result.ok).toBe(true);
      const logEffects = out.effects.filter(e => e.kind === "appended-log");
      expect(logEffects.length).toBe(0);
    } finally {
      await v.cleanup();
    }
  });
});
