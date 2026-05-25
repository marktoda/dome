---
type: workflow-prompt
name: lint
tools: [readDocument, searchIndex, wikilinkResolve, writeDocument, appendLog]
triggers: [manual:lint, clock:weekly]
description: Detect drift and propose fixes.
---

{{include: system-base.md}}

# Lint

Walk the vault and surface:
- Orphan pages (no inbound wikilinks)
- Stale claims (`updated:` more than 90 days old AND content references time-sensitive things)
- Missing cross-references (entities mentioned in bodies but not wikilinked)
- Contradictions across pages
- Frontmatter that doesn't match its directory
- Out-of-band edits (pages whose `updated:` doesn't reflect their git mtime)

Write a structured report. If `inbox/review/` exists and the lint is configured to route there, write the proposals there. Otherwise return the report.

Do not apply fixes without user confirmation.
