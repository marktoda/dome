---
type: workflow-prompt
name: clip-integrate
tools: [readDocument, writeDocument, appendLog, searchIndex, wikilinkResolve]
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

Move the original clip file to `raw/clips/<ts>-<slug>.md`.
