---
type: workflow-prompt
name: research
tools: [readDocument, writeDocument, appendLog, searchIndex, wikilinkResolve]
triggers: [intake:inbox/research/*, intent:research]
description: External research; produce a source page; propose related updates. (opt-in)
---

{{include: system-base.md}}

# Research

The user asked you to research a topic. You don't have web access via a dedicated Tool — but you may be operating in a harness that provides one.

1. Gather what's in the vault first via `searchIndex` + `readDocument`.
2. State what you'd want to verify externally if you had access.
3. Synthesize a `wiki/sources/<topic>.md` page with `external: true` in frontmatter to mark claims as external research.
4. Propose updates to related concept / entity pages — but distinguish your claims from user-believed claims using the `external: true` marker.
