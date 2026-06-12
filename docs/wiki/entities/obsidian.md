---
type: entity
description: "Markdown editor recommended as Dome's vault browser surface; not a harness — its native writes flow through the engine's adoption path."
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
tags: ["editor", "markdown"]
---

# Obsidian

Markdown editor with native wikilink support, a graph view, and a plugin ecosystem. Dome's recommended browser surface for vaults: a Dome vault opens in Obsidian without configuration; everything Obsidian already does (search, graph, backlinks, hotkeys) continues to work because the vault is just markdown.

Obsidian is *not* a harness — it doesn't host an agent loop. It reads markdown directly and writes via its built-in editor. Obsidian-side writes are native filesystem writes; the watcher catches them and the engine constructs Proposals per [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]]. This is by design: see [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] and [[wiki/specs/harnesses]] §"What's NOT a harness."

## Recommended settings

For best compatibility with Dome's adoption-phase diagnostics:

- **Preferences → Files & Links → Default link format:** Absolute path in vault. Makes Obsidian's auto-completed wikilinks satisfy the `dome.markdown.validate-wikilinks` adoption-phase processor (which emits a blocking DiagnosticEffect on short-form links per [[wiki/specs/processors]] §"First-party processors").
- **Preferences → Files & Links → New link format:** Same setting; ensures new links default to full path.

Native edits from Obsidian flow through the same engine adoption path as any other write (see [[wiki/gotchas/out-of-band-vault-edits]]); these settings minimize blocking diagnostics on otherwise valid edits.

## See also

- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]
- [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]]
- [[wiki/specs/processors]] §"First-party processors" — the `dome.markdown` bundle that validates wikilinks
- [[wiki/gotchas/out-of-band-vault-edits]]
