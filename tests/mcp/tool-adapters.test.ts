import { describe, test, expect } from "bun:test";
import { buildToolAdapters } from "../../src/mcp/tool-adapters";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("MCP tool adapters", () => {
  test("buildToolAdapters returns 7 adapters", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const adapters = buildToolAdapters(res.value);
      expect(adapters.length).toBe(7);
      expect(adapters.find(a => a.name === "dome.write_document")).toBeDefined();
    } finally {
      await v.cleanup();
    }
  });

  test("write_document adapter calls vault.tools.writeDocument", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const adapters = buildToolAdapters(res.value);
      const writeAdapter = adapters.find(a => a.name === "dome.write_document")!;
      const result = await writeAdapter.handler({
        path: "wiki/entities/danny.md",
        body: "# Danny",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      expect(result.ok).toBe(true);
    } finally {
      await v.cleanup();
    }
  });
});
