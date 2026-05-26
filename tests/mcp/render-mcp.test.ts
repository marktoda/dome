// Pins the renderMcp(surface) contract per docs/wiki/specs/sdk-surface.md
// §"renderMcp (in @dome/sdk/mcp)" and docs/wiki/specs/mcp-surface.md
// §"Construction":
//
//   - tools: ToolAdapter[] with dome.* snake_case names
//   - prompts: McpPromptAdapter[] with dome.workflow.<name> / dome.system_prompt
//   - resources: ResourceAdapter that registers dome:// URIs
//   - instructions: passed through unchanged

import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { buildAbstractSurface } from "../../src/abstract-surface";
import { renderMcp } from "../../src/mcp/render-mcp";
import { ResourceAdapter } from "../../src/mcp/resource-adapters";
import { makeTestVault } from "../helpers/make-test-vault";

describe("renderMcp", () => {
  test("projects tools to ToolAdapter[] with dome.* snake_case names", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const surface = await buildAbstractSurface(res.value);
      const mcp = renderMcp(surface);

      expect(mcp.tools.length).toBe(7);
      for (const t of mcp.tools) {
        expect(t.name.startsWith("dome.")).toBe(true);
        expect(t.name).toMatch(/^dome\.[a-z_]+$/);
        expect(typeof t.description).toBe("string");
        expect(typeof t.handler).toBe("function");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("projects prompts to McpPromptAdapter[] with dome.workflow.<name> / dome.system_prompt", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const surface = await buildAbstractSurface(res.value);
      const mcp = renderMcp(surface);

      expect(mcp.prompts.length).toBeGreaterThan(0);
      const names = mcp.prompts.map((p) => p.name);
      expect(names).toContain("dome.system_prompt");
      for (const name of names) {
        expect(name.startsWith("dome.")).toBe(true);
      }
    } finally {
      await v.cleanup();
    }
  });

  test("resources is a ResourceAdapter instance with dome:// URIs", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const surface = await buildAbstractSurface(res.value);
      const mcp = renderMcp(surface);

      expect(mcp.resources).toBeInstanceOf(ResourceAdapter);
      const listing = await mcp.resources.list();
      for (const r of listing) {
        expect(r.uri.startsWith("dome://")).toBe(true);
      }
    } finally {
      await v.cleanup();
    }
  });

  test("instructions is passed through unchanged", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault failed to open");
      const surface = await buildAbstractSurface(res.value);
      const mcp = renderMcp(surface);

      expect(mcp.instructions).toBe(surface.instructions);
    } finally {
      await v.cleanup();
    }
  });
});
