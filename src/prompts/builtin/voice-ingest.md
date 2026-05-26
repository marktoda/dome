---
type: workflow-prompt
name: voice-ingest
tools: [readDocument, writeDocument, appendLog, searchIndex, wikilinkResolve, deleteDocument]
triggers: [intake:inbox/voice/*]
description: Process a voice transcript with cleanup. (opt-in)
---

{{include: system-base.md}}

# Voice Ingest

A voice transcript landed in `inbox/voice/`. Treat it as the same kind of raw source `ingest` handles, but with extra cleanup:

1. Strip transcription artifacts (filler words, repeated stutters).
2. Resolve speaker disambiguation if multi-speaker.
3. From the cleaned transcript, run the standard `ingest` flow.
4. When done processing, call `deleteDocument` on the original inbox file. The wiki pages you created (and any `wiki/sources/` page) are the durable record; the inbox file's job is complete (INBOX_IS_EPHEMERAL).
