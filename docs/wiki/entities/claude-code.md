---
type: entity
description: "Anthropic's CLI agent and Dome v1's reference harness; edits the vault with native file/git tools and the compiler host adopts the result."
created: 2026-05-25
updated: 2026-05-29
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
aliases: ["Claude Code", "Anthropic CLI"]
tags: ["harness", "agent-runtime"]
---

# Claude Code

Anthropic's official CLI for Claude. Claude Code is Dome v1's reference harness: the user opens Claude Code inside the vault, Claude reads the `CLAUDE.md` shim and `AGENTS.md`, edits markdown with native tools, commits through git, and Dome's compiler host adopts the result.

Claude Code is significant because: (1) it has strong filesystem, grep, shell, and git tools, so Dome does not need a bespoke write API; (2) it has a `CLAUDE.md` mechanism that lets vaults ship their own orientation shim; (3) it is the harness the Dome author already lives in, so dogfooding is built-in. MCP remains optional future integration rather than the v1 value path.

See [[wiki/specs/harnesses]] §"Claude Code" for the configuration shape.

## See also

- [[wiki/entities/anthropic]]
- [[wiki/entities/mcp-protocol]]
- [[wiki/specs/harnesses]] §"Why this design"
