---
type: workflow-prompt
name: clip-integrate
tools: [readDocument, writeDocument, appendLog, searchIndex, wikilinkResolve, deleteDocument]
triggers: [intake:inbox/clip/*]
description: Integrate a web clip — summarize, source-page, cross-reference. (opt-in)
---

{{include: system-base.md}}

# Clip Integrate

A web clip landed in `inbox/clip/`. Integrate it:

1. Extract the URL + title from the clip.
2. Create `wiki/sources/<slug>.md` with `external: true` in frontmatter and the URL.
3. Summarize the clip in the body.
4. Find existing pages that match the topic via `searchIndex` and propose cross-references.
5. When done processing, call `deleteDocument` on the original inbox file. The `wiki/sources/` page you created is the durable record; the inbox file's job is complete (INBOX_IS_EPHEMERAL).

{{include: clip-integrate-augment.md}}
