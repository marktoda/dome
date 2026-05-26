import { describe, test, expect } from "bun:test";
import { DomeMcpServer } from "../../src/mcp/server";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";
import type { ServerLike } from "../../src/mcp/handlers";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Captures registered handlers so the test can invoke them directly without a
// real stdio Server. Keyed by the schema object identity.
function makeStubServer(): { server: ServerLike; handlers: Map<unknown, (r: unknown) => Promise<unknown>> } {
  const handlers = new Map<unknown, (r: unknown) => Promise<unknown>>();
  const server: ServerLike = {
    setRequestHandler: (schema, handler) => {
      handlers.set(schema, handler as (r: unknown) => Promise<unknown>);
    },
  };
  return { server, handlers };
}

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

  test("registerOn wires all 6 MCP request handlers", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const server = new DomeMcpServer({ vault: res.value });
      const { server: stub, handlers } = makeStubServer();
      await server.registerOn(stub);
      expect(handlers.size).toBe(6);
      expect(handlers.has(ListToolsRequestSchema)).toBe(true);
      expect(handlers.has(CallToolRequestSchema)).toBe(true);
      expect(handlers.has(ListPromptsRequestSchema)).toBe(true);
      expect(handlers.has(GetPromptRequestSchema)).toBe(true);
      expect(handlers.has(ListResourcesRequestSchema)).toBe(true);
      expect(handlers.has(ReadResourceRequestSchema)).toBe(true);
    } finally {
      await v.cleanup();
    }
  });

  test("tools/list handler returns 7 tools with JSON Schema input shape", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const server = new DomeMcpServer({ vault: res.value });
      const { server: stub, handlers } = makeStubServer();
      await server.registerOn(stub);
      const handler = handlers.get(ListToolsRequestSchema)!;
      const out = (await handler({})) as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
      expect(out.tools.length).toBe(7);
      // every tool should have a JSON-Schema input shape (not a Zod schema)
      for (const t of out.tools) {
        expect(typeof t.inputSchema).toBe("object");
        expect(t.inputSchema).toHaveProperty("type");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("prompts/list handler exposes dome.system_prompt", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const server = new DomeMcpServer({ vault: res.value });
      const { server: stub, handlers } = makeStubServer();
      await server.registerOn(stub);
      const handler = handlers.get(ListPromptsRequestSchema)!;
      const out = (await handler({})) as { prompts: Array<{ name: string }> };
      expect(out.prompts.find(p => p.name === "dome.system_prompt")).toBeDefined();
    } finally {
      await v.cleanup();
    }
  });

  test("resources/list handler returns 3 resources", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const server = new DomeMcpServer({ vault: res.value });
      const { server: stub, handlers } = makeStubServer();
      await server.registerOn(stub);
      const handler = handlers.get(ListResourcesRequestSchema)!;
      const out = (await handler({})) as { resources: Array<{ uri: string }> };
      expect(out.resources.length).toBe(3);
    } finally {
      await v.cleanup();
    }
  });

  test("instructions() returns rich orientation: system-base + invariants + page types + AGENTS.md fallback", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const server = new DomeMcpServer({ vault: res.value });
      const out = await server.instructions();
      expect(out).toContain("# Dome — Wiki Maintainer");
      expect(out).toContain("### Enabled invariants");
      expect(out).toContain("- EVERY_WRITE_IS_LOGGED");
      expect(out).toContain("### Page types");
      expect(out).toContain("- entity");
      expect(out).toContain("### Vault notes (from AGENTS.md)");
      expect(out).toContain("_No AGENTS.md present._");
    } finally {
      await v.cleanup();
    }
  });

  test("instructions() caches across calls", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const server = new DomeMcpServer({ vault: res.value });
      const first = await server.instructions();
      const second = await server.instructions();
      expect(second).toBe(first);
    } finally {
      await v.cleanup();
    }
  });
});
