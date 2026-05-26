import { describe, test, expect } from "bun:test";
import { McpToolName, MCP_TOOL_NAMES } from "../../src/mcp/tool-names";

describe("McpToolName enum", () => {
  test("7 MCP tools", () => { expect(MCP_TOOL_NAMES.length).toBe(7); });
  test("all are dome.* prefixed", () => {
    for (const n of MCP_TOOL_NAMES) expect(n.startsWith("dome.")).toBe(true);
  });
  test("ReadDocument value is dome.read_document", () => {
    expect(McpToolName.ReadDocument).toBe("dome.read_document");
  });
});
