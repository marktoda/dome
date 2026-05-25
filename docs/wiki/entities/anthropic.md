---
type: entity
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
tags: ["vendor", "llm"]
---

# Anthropic

AI safety company. Vendor of the Claude model family (Opus, Sonnet, Haiku) and the `@anthropic-ai/sdk` TypeScript client Dome's headless agent loop uses. Also publishes Claude Code (see [[wiki/entities/claude-code]]) and MCP (see [[wiki/entities/mcp-protocol]]).

Dome v0.5 calls Anthropic's models via the SDK for all LLM operations. Model selection is per-workflow (configured in workflow prompt frontmatter) — most v0.5 workflows default to Sonnet for cost/latency balance; high-stakes flows (sensitivity classification, lint synthesis) opt into Opus.

## See also

- [[wiki/entities/claude-code]]
- [[wiki/entities/mcp-protocol]]
