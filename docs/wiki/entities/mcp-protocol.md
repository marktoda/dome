---
type: entity
aliases:
  - MCP
  - Model Context Protocol
tags:
  - protocol
  - standard
created: 2026-05-25
updated: 2026-06-09
sources:
  - "[[cohesive/brainstorms/2026-05-25-dome-vision]]"
---

# Model Context Protocol (MCP)

Open protocol for connecting AI applications to data sources and tools. Published by Anthropic but vendor-neutral; supported by Claude Code, Cursor, OpenCode, Codex CLI, and others.

For Dome v1, MCP is an optional protocol adapter, not the universal mount point. The load-bearing Claude Code workflow uses the vault orientation files, normal filesystem/git tools, and the CLI/compiler host. The shipped Dome MCP server (`dome mcp`, wedge Phase 5) exposes typed capture/read/query/decision tools for harnesses that benefit from MCP routing; it does not replace the Git-native write path. See [[wiki/specs/mcp-surface]].

MCP still supports the interface-agnostic principle (see [[wiki/specs/harnesses]] §"Why this design"), but v1 deliberately avoids depending on it because many agentic harnesses already have good shell, file, grep, and git tools.

## See also

- [[wiki/specs/mcp-surface]]
- [[wiki/entities/anthropic]]
- [[wiki/specs/harnesses]]
