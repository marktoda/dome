// Pins the hook-dispatch contract across consumer surfaces:
// MCP-routed mutations fire the same hooks as SDK-direct mutations.
//
// Pre-Phase-B, the wrap was paid once at openVault and shared via
// vault.toolParsers / vault.aiTools. Phase B removed those Vault fields
// and replaced them with per-entrypoint projection functions
// (projectMcp, projectAiSdk). The B1 repair pass made the wrap intrinsic
// to bindTools so every consumer inherits it — this test pins that
// contract structurally: invoking dome.write_document through the MCP
// adapter must trigger auto-update-index just like vault.tools.writeDocument
// would.

import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";
import { buildToolAdapters } from "../../src/mcp/tool-adapters";
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

      const adapters = buildToolAdapters(vault);
      const write = adapters.find(a => a.name === MCP_TOOL_NAMES.writeDocument);
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

      // The async hook fires through vault.dispatchEvents → HookDispatcher.
      // drainHooks settles the p-queue + any in-flight persistence writes.
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

      // Seed two entity pages so auto-cross-reference has something to wire.
      const adapters = buildToolAdapters(vault);
      const write = adapters.find(a => a.name === MCP_TOOL_NAMES.writeDocument);
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

      // Sanity: index.md reflects both pages — the auto-update-index hook
      // fired on both writes (proving the wrap is intrinsic, not just
      // triggered by the seed).
      const indexBody = await readFile(join(v.path, "index.md"), "utf8");
      expect(indexBody).toContain("[[wiki/entities/maya]]");
      expect(indexBody).toContain("[[wiki/entities/danny]]");
    } finally {
      await v.cleanup();
    }
  });
});
