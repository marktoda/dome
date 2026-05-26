// Pins the MCP tool name catalog per docs/wiki/specs/mcp-surface.md
// §"Tool catalog (mirrors SDK)". The canonical source is the Record
// `MCP_TOOL_NAMES` in src/tools/registry.ts (one MCP tool per SDK Tool,
// snake_case + dome.* prefix). The PascalCase enum + array form from
// src/mcp/tool-names.ts (deleted in Phase D) are gone — consumers that
// need the array derive it via Object.values(MCP_TOOL_NAMES).

import { describe, test, expect } from "bun:test";
import { MCP_TOOL_NAMES, TOOL_NAMES } from "../../src/tools/registry";

describe("MCP tool name catalog", () => {
  test("7 MCP tools", () => {
    expect(Object.keys(MCP_TOOL_NAMES).length).toBe(7);
  });

  test("MCP_TOOL_NAMES has one entry per canonical Tool", () => {
    for (const name of TOOL_NAMES) {
      expect(MCP_TOOL_NAMES[name]).toBeDefined();
    }
  });

  test("all are dome.* prefixed and snake_case", () => {
    for (const value of Object.values(MCP_TOOL_NAMES)) {
      expect(value.startsWith("dome.")).toBe(true);
      expect(value).toMatch(/^dome\.[a-z_]+$/);
    }
  });

  test("writeDocument maps to dome.write_document", () => {
    expect(MCP_TOOL_NAMES.writeDocument).toBe("dome.write_document");
  });
});
