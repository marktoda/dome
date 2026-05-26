---
type: workflow-prompt
name: sensitivity-classify
tools: [readDocument, writeDocument, appendLog]
triggers: []
description: Classify content sensitivity; route to inbox/review/ if sensitive. Sub-workflow of ingest. (opt-in)
---

{{include: system-base.md}}

# Sensitivity Classify

Sub-workflow: invoked from `ingest` when `SENSITIVE_GOES_TO_INBOX` is enabled.

Classify the candidate write:
- `normal` — proceed to wiki/
- `sensitive` — write to `inbox/review/<filename>.md` instead, with a `classification_rationale` field in frontmatter

Sensitive categories: personal medical, financial, confidential employment, named third parties speaking off-the-record, anything the user marked private upstream.

Output: the classification + reasoning. The calling `ingest` workflow gates the actual `writeDocument` destination on this result.

{{include: sensitivity-classify-augment.md}}
