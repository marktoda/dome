// Pins the ConsumerSurface contract from docs/wiki/specs/sdk-surface.md
// §"Consumer surfaces": buildConsumerSurface(vault) returns the four-kind
// aggregation; DomeMcpServer({ surface, vault }) consumes it.

import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { buildConsumerSurface, DomeMcpServer } from "../../src/mcp";
import { ResourceAdapter } from "../../src/mcp/resource-adapters";
import { makeTestVault } from "../helpers/make-test-vault";

describe("ConsumerSurface", () => {
  test("buildConsumerSurface returns { tools, prompts, resources, instructions }", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const vault = res.value;

      const surface = await buildConsumerSurface(vault);

      // Shape: four kinds
      expect(surface.tools).toBe(vault.tools);
      expect(Array.isArray(surface.prompts)).toBe(true);
      expect(surface.prompts.length).toBeGreaterThan(0);
      expect(surface.resources).toBeInstanceOf(ResourceAdapter);
      expect(typeof surface.instructions).toBe("string");
      expect(surface.instructions.length).toBeGreaterThan(0);
    } finally {
      await v.cleanup();
    }
  });

  test("DomeMcpServer({ surface, vault }) wires the seven tool adapters", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const vault = res.value;

      const surface = await buildConsumerSurface(vault);
      const server = new DomeMcpServer({ surface, vault });

      expect(server.tools.length).toBe(7);
      expect(surface.prompts.length).toBeGreaterThan(0);
    } finally {
      await v.cleanup();
    }
  });
});
