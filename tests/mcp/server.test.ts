import { describe, test, expect } from "bun:test";
import { DomeMcpServer } from "../../src/mcp/server";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("DomeMcpServer", () => {
  test("wires 7 tools + resource adapter + prompts", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const server = new DomeMcpServer({ vault: res.value });
      expect(server.tools.length).toBe(7);
      const prompts = await server.prompts();
      expect(prompts.length).toBeGreaterThanOrEqual(5);
      const resources = await server.resources.list();
      expect(resources.length).toBe(3);
    } finally {
      await v.cleanup();
    }
  });

  test("caches prompts on repeat calls", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const server = new DomeMcpServer({ vault: res.value });
      const first = await server.prompts();
      const second = await server.prompts();
      expect(second).toBe(first);
    } finally {
      await v.cleanup();
    }
  });
});
