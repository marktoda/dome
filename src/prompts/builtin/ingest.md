---
type: workflow-prompt
name: ingest
tools: [readDocument, writeDocument, appendLog, searchIndex, wikilinkResolve, deleteDocument]
triggers: [intake:inbox/raw/*, intent:capture-thought]
description: Process a new raw source into wiki updates.
---

{{include: system-base.md}}
{{include: preamble-rendering-surface.md}}

# Ingest

This is the `ingest` workflow. Process the raw source the user (or an intake hook) provided.

1. Read the raw file (or use the content the user gave you).
2. Identify atoms: entities mentioned, concepts touched, sources cited, decisions captured.
3. For each atom, decide whether to update an existing wiki page or propose a new one.
4. For new pages: require recurrence (the atom should be expected to come up again) OR explicit naming OR structural need. Do not create one-shot pages.
5. Write proposed updates via `writeDocument`. Use full-path wikilinks. Match `wiki/<type>/` to the frontmatter `type:`.
6. If `SENSITIVE_GOES_TO_INBOX` is enabled, classify content first (sensitive content routes to `inbox/review/`).
7. Append a `log.md` entry summarizing what you did via `appendLog`.
8. When done processing, call `deleteDocument` on the original inbox file. The wiki/source pages you created are the durable record; the inbox file's job is complete (INBOX_IS_EPHEMERAL).

You may write 5-15 page touches per call. Don't write nothing; don't write hundreds. The goal is to keep the wiki compiled, not exhaustive.

{{include: ingest-augment.md}}

{{include: ingest-epilogue.md}}
