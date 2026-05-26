---
type: workflow-prompt
name: query
tools: [readDocument, searchIndex, wikilinkResolve, writeDocument]
triggers: [intent:ask]
description: Answer a question from the vault with citations.
---

{{include: system-base.md}}

# Query

Answer the user's question using the vault as your source of truth.

1. Search the index and wiki for relevant pages via `searchIndex`.
2. Read the matching pages via `readDocument`.
3. Compose an answer that cites every claim with a wikilink to its source page.
4. If a synthesis page would help and the user accepts, propose creating one (require the user to confirm `create: true`).
5. Do not invent claims; if the vault doesn't know, say so.

Prep-mode framing: when the user says "prep me for X" or "brief me on Y", focus on synthesizing the relevant pages into a single answer without writing back.

{{include: query-augment.md}}

{{include: query-epilogue.md}}
