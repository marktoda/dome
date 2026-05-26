// Pins the hook-dispatch contract across consumer surfaces: MCP-routed
// mutations fire the same hooks as SDK-direct mutations. The wrap is
// intrinsic to vault.tools (via wrapMutatingInvoke); renderMcp consumes
// surface.tools so the wrap inherits by construction.

import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";
import { buildAbstractSurface } from "../../src/abstract-surface";
import { renderMcp } from "../../src/mcp/render-mcp";
import { MCP_TOOL_NAMES } from "../../src/tools/registry";
import { makeTestVault } from "../helpers/make-test-vault";

describe("MCP routes fire shipped-default hooks", () => {
  test("dome.write_document → auto-update-index updates index.md", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const vault = res.value;

      const surface = await buildAbstractSurface(vault);
      const mcp = renderMcp(surface);
      const write = mcp.tools.find((a) => a.name === MCP_TOOL_NAMES.writeDocument);
      expect(write).toBeDefined();

      const handlerResult = await write!.handler({
        path: "wiki/entities/danny.md",
        body: "# Danny",
        frontmatter: {
          type: "entity",
          created: "2026-05-25",
          updated: "2026-05-25",
          sources: [],
        },
        opts: { create: true },
      });
      expect(handlerResult.ok).toBe(true);

      await vault.drainHooks();

      const indexBody = await readFile(join(v.path, "index.md"), "utf8");
      expect(indexBody).toContain("[[wiki/entities/danny]]");
    } finally {
      await v.cleanup();
    }
  });

  test("dome.write_document fires auto-cross-reference for entity pages", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const vault = res.value;

      const surface = await buildAbstractSurface(vault);
      const mcp = renderMcp(surface);
      const write = mcp.tools.find((a) => a.name === MCP_TOOL_NAMES.writeDocument);
      expect(write).toBeDefined();

      const seed = await write!.handler({
        path: "wiki/entities/maya.md",
        body: "# Maya",
        frontmatter: {
          type: "entity",
          created: "2026-05-25",
          updated: "2026-05-25",
          sources: [],
        },
        opts: { create: true },
      });
      expect(seed.ok).toBe(true);

      const ref = await write!.handler({
        path: "wiki/entities/danny.md",
        body: "# Danny\n\nSee also [[wiki/entities/maya]].",
        frontmatter: {
          type: "entity",
          created: "2026-05-25",
          updated: "2026-05-25",
          sources: [],
        },
        opts: { create: true },
      });
      expect(ref.ok).toBe(true);

      await vault.drainHooks();

      const indexBody = await readFile(join(v.path, "index.md"), "utf8");
      expect(indexBody).toContain("[[wiki/entities/maya]]");
      expect(indexBody).toContain("[[wiki/entities/danny]]");
    } finally {
      await v.cleanup();
    }
  });
});
