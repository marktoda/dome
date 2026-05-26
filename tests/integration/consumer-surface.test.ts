// Pins the AbstractSurface + renderMcp chain per docs/wiki/specs/sdk-surface.md
// §"Consumer surfaces". The test name preserves the "consumer-surface"
// shape for git history continuity even though ConsumerSurface as a type
// no longer exists — the file pins the four-kind aggregation contract.

import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { buildAbstractSurface } from "../../src/index";
import { renderMcp, DomeMcpServer } from "../../src/mcp";
import { ResourceAdapter } from "../../src/mcp/resource-adapters";
import { makeTestVault } from "../helpers/make-test-vault";

describe("AbstractSurface + renderMcp (consumer-surface contract)", () => {
  test("buildAbstractSurface returns { tools, prompts, resources, instructions }", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const vault = res.value;

      const surface = await buildAbstractSurface(vault);

      // tools IS vault.tools (the protocol-agnostic BoundToolSurface).
      expect(surface.tools).toBe(vault.tools);
      // prompts is a descriptor list (no dome.* prefix).
      expect(Array.isArray(surface.prompts)).toBe(true);
      expect(surface.prompts.length).toBeGreaterThan(0);
      // resources is a descriptor list (no dome:// prefix).
      expect(Array.isArray(surface.resources)).toBe(true);
      expect(surface.resources.length).toBeGreaterThan(0);
      // instructions is a string.
      expect(typeof surface.instructions).toBe("string");
      expect(surface.instructions.length).toBeGreaterThan(0);
    } finally {
      await v.cleanup();
    }
  });

  test("renderMcp(surface) + DomeMcpServer wires the seven tool adapters", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const vault = res.value;

      const surface = await buildAbstractSurface(vault);
      const mcp = renderMcp(surface);
      const server = new DomeMcpServer({ surface: mcp });

      expect(server.tools.length).toBe(7);
      expect(mcp.prompts.length).toBeGreaterThan(0);
      expect(mcp.resources).toBeInstanceOf(ResourceAdapter);
    } finally {
      await v.cleanup();
    }
  });
});
