---
type: entity
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
aliases: ["MCP", "Model Context Protocol"]
tags: ["protocol", "standard"]
---

# Model Context Protocol (MCP)

Open protocol for connecting AI applications to data sources and tools. Published by Anthropic but vendor-neutral; supported by Claude Code, Cursor, OpenCode, Codex CLI, and others.

For Dome, MCP is the universal mount point. The Dome MCP server exposes the SDK's Tools as MCP tools, Dome's prompts as MCP prompts, and the vault as MCP resources. Any MCP-capable harness becomes Dome-aware by adding one config line — see [[wiki/specs/mcp-surface]].

MCP is what makes the *interface-agnostic* principle practical (see [[wiki/specs/harnesses]] §"Why this design"). Without MCP, every harness would need a bespoke Dome integration.

## See also

- [[wiki/specs/mcp-surface]]
- [[wiki/entities/anthropic]]
- [[wiki/specs/harnesses]]
