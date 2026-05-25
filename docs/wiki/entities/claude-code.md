---
type: entity
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
aliases: ["Claude Code", "Anthropic CLI"]
tags: ["harness", "agent-runtime"]
---

# Claude Code

Anthropic's official CLI for Claude. The v0.5 reference harness for Dome — the user's existing workflow upgrades in place once the Dome MCP server is added to Claude Code's config.

Claude Code is significant because: (1) it has mature MCP support, so mounting Dome is one config line; (2) it has a `CLAUDE.md` mechanism that lets vaults ship their own system prompt; (3) it is the harness the Dome author already lives in, so dogfooding is built-in.

See [[wiki/specs/harnesses]] §"Claude Code" for the configuration shape.

## See also

- [[wiki/entities/anthropic]]
- [[wiki/entities/mcp-protocol]]
- [[wiki/specs/harnesses]] §"Why this design"
