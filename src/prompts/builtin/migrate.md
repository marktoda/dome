---
type: workflow-prompt
name: migrate
tools: [readDocument, writeDocument, moveDocument, deleteDocument, appendLog, searchIndex, wikilinkResolve]
triggers: [manual:migrate]
description: Convert an existing markdown vault to Dome shape.
---

{{include: system-base.md}}

# Migrate

Convert the directory at `<path>` to a Dome vault.

1. Scan the directory; identify probable categories (raw vs wiki vs notes) from file shape and naming.
2. Detect existing typed-page layout if present (e.g., Obsidian's daily notes, an existing entities/ folder).
3. Propose a migration plan: which files move (via `moveDocument`), which frontmatter to add (via `writeDocument`), which invariants would be violated and how to fix.
4. Write the proposal to `<path>/.dome/migration-plan.md` for user review.
5. On `--apply`, execute the plan via Dome's Tools. Every move and frontmatter-add is logged.
