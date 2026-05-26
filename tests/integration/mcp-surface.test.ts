// AC5: a Claude Code session opening a Dome vault via the MCP server sees
//   - 7 MCP tools (the canonical Tool surface)
//   - >=5 MCP prompts (the 5 shipped-default workflows; +4 opt-in if activated)
//   - 3 MCP resources (index, log, vault info)
//
// This is the full init -> openVault -> DomeMcpServer assembly path, not the
// hand-built fixture used by tests/mcp/server.test.ts. It pins the surface a
// real harness sees after running `dome init`.

import { describe, test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domeInit } from "../../src/cli/commands/init";
import { openVault } from "../../src/vault";
import { DomeMcpServer } from "../../src/mcp/server";
import { buildConsumerSurface } from "../../src/mcp/consumer-surface";
import { MCP_TOOL_NAMES } from "../../src/mcp/tool-names";

describe("MCP surface (AC5)", () => {
  test("init -> open -> DomeMcpServer exposes 7 tools, >=5 prompts, 3 resources", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-mcp-surface-"));
    const vaultPath = join(base, "vault");
    try {
      const initRes = await domeInit(vaultPath);
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;

      const openRes = await openVault(vaultPath);
      expect(openRes.ok).toBe(true);
      if (!openRes.ok) return;

      const surface = await buildConsumerSurface(openRes.value);
      const server = new DomeMcpServer({ surface });

      // 7 canonical tools.
      expect(server.tools.length).toBe(7);
      const toolNames = server.tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([...MCP_TOOL_NAMES].sort());

      // >=6 prompts: 5 shipped-default workflows + dome.system_prompt. A
      // vault that activates opt-in workflows would observe more.
      const prompts = surface.prompts;
      expect(prompts.length).toBeGreaterThanOrEqual(6);
      // dome.system_prompt is exposed as a first-class MCP prompt; every
      // other prompt carries the canonical dome.workflow.* prefix.
      expect(prompts.find((p) => p.name === "dome.system_prompt")).toBeDefined();
      for (const p of prompts) {
        if (p.name === "dome.system_prompt") continue;
        expect(p.name.startsWith("dome.workflow.")).toBe(true);
      }

      // 3 resources: index, log, vault info.
      const resources = await surface.resources.list();
      expect(resources.length).toBe(3);
      const uris = resources.map((r) => r.uri).sort();
      expect(uris).toEqual(["dome://index", "dome://log", "dome://vault/info"]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
