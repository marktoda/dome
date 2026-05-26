---
type: workflow-prompt
name: migrate
tools: [readDocument, writeDocument, moveDocument, deleteDocument, appendLog, searchIndex, wikilinkResolve]
triggers: [manual:migrate]
description: Convert an existing markdown vault to Dome shape.
---

{{include: system-base.md}}

# Migrate

Convert the current vault to Dome shape. The prologue above names the vault's path; operate on that directory.

1. Scan the vault; identify probable categories (raw vs wiki vs notes) from file shape and naming.
2. Detect existing typed-page layout if present (e.g., Obsidian's daily notes, an existing `entities/` folder).
3. Propose a migration plan: which files move (via `moveDocument`), which frontmatter to add (via `writeDocument`), which invariants would be violated and how to fix.
4. Write the proposal to `.dome/migration-plan.md` for user review.
5. If the user message says to apply, execute the plan via Dome's Tools. Every move and frontmatter-add is logged. Otherwise write the plan only; do not execute.
