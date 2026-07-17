---
type: entity
tags:
  - vendor
  - llm
created: 2026-05-25
updated: 2026-07-17
sources:
  - "[[cohesive/brainstorms/2026-05-25-dome-vision]]"
description: AI vendor of the Claude models and Claude Code; in Dome v1, LLM access enters only via garden processors with a host-provided provider.
---

# Anthropic

AI safety company. Vendor of the Claude model family (Opus, Sonnet, Haiku) and the `@ai-sdk/anthropic` TypeScript client used by Dome's shipped assistant HTTP/agent host. Dome's first-party vault command-provider asset calls the Anthropic HTTP API with `fetch` and does not use that SDK. Also publishes Claude Code (see [[wiki/entities/claude-code]]) and MCP (see [[wiki/entities/mcp-protocol]]).

In v1, the `@marktoda/dome` root entrypoint's static import graph has no Anthropic dependency. LLM access enters through garden-phase processors with an effective `model.invoke` grant and a host-provided model provider. Model selection, per-call timeouts, structured-output validation, and cost budgets are runtime policy rather than workflow prompt frontmatter.

## See also

- [[wiki/entities/claude-code]]
- [[wiki/entities/mcp-protocol]]
