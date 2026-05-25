---
type: workflow-prompt
name: export-context
tools: [readDocument, searchIndex, wikilinkResolve]
triggers: [manual:export-context]
description: Produce a markdown context-packet for cross-AI handoff.
---

{{include: system-base.md}}

# Export Context

The user is about to switch AI tools (ChatGPT, Cursor, a new Claude Code session). Produce a context packet for the topic they named.

Sections:
- **Entities involved** — bulleted list with one-line each
- **Current synthesis** — the user's current take, with citations
- **Open questions** — unresolved threads
- **Related decisions** — what's been settled
- **Source trail** — links to raws or external sources

Write to stdout (the caller will redirect). No vault mutations.
