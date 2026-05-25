---
type: entity
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
tags: ["editor", "markdown"]
---

# Obsidian

Markdown editor with native wikilink support, a graph view, and a plugin ecosystem. Dome's recommended browser surface for vaults: a Dome vault opens in Obsidian without configuration; everything Obsidian already does (search, graph, backlinks, hotkeys) continues to work because the vault is just markdown.

Obsidian is *not* a harness — it doesn't host an agent loop and doesn't go through Dome's Tools. It reads markdown directly. This is by design: see [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] and [[wiki/specs/harnesses]] §"What's NOT a harness."

## Recommended settings

For best compatibility with Dome's invariants:

- **Preferences → Files & Links → Default link format:** Absolute path in vault. Makes Obsidian's auto-completed wikilinks compatible with [[wiki/invariants/WIKILINKS_ARE_FULLPATH]].
- **Preferences → Files & Links → New link format:** Same setting; ensures new links default to full path.

Out-of-band edits in Obsidian are tolerated (see [[wiki/gotchas/out-of-band-vault-edits]]); these settings minimize drift.

## See also

- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]
- [[wiki/invariants/WIKILINKS_ARE_FULLPATH]]
- [[wiki/gotchas/out-of-band-vault-edits]]
