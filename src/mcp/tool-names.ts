// MCP tool name catalog (snake_case per MCP convention).
// One MCP tool per SDK Tool. See docs/wiki/specs/mcp-surface.md §"Tool catalog".

export const McpToolName = {
  ReadDocument: "dome.read_document",
  WriteDocument: "dome.write_document",
  AppendLog: "dome.append_log",
  SearchIndex: "dome.search_index",
  WikilinkResolve: "dome.wikilink_resolve",
  MoveDocument: "dome.move_document",
  DeleteDocument: "dome.delete_document",
} as const;

export type McpToolName = typeof McpToolName[keyof typeof McpToolName];

export const MCP_TOOL_NAMES: ReadonlyArray<McpToolName> = Object.values(McpToolName);
