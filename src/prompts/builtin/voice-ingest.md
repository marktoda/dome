---
type: workflow-prompt
name: voice-ingest
tools: [readDocument, writeDocument, appendLog, searchIndex, wikilinkResolve]
triggers: [intake:inbox/voice/*]
description: Process a voice transcript with cleanup. (opt-in)
---

{{include: system-base.md}}

# Voice Ingest

A voice transcript landed in `inbox/voice/`. Treat it as the same kind of raw source `ingest` handles, but with extra cleanup:

1. Strip transcription artifacts (filler words, repeated stutters).
2. Resolve speaker disambiguation if multi-speaker.
3. From the cleaned transcript, run the standard `ingest` flow.

Move the file to `raw/captures/<ts>-<slug>.md` when done.
