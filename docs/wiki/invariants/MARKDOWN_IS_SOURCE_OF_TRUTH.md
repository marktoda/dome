---
type: invariant
created: 2026-05-25
updated: 2026-05-25
sources: ["[[raw/original-architecture]]", "[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
tier: axiom
---

# MARKDOWN_IS_SOURCE_OF_TRUTH

**Tier:** Axiom — non-disable-able.

**Statement:** The markdown files in the vault are the canonical state. Any derived data structure (in-memory index, search cache, page registry, plugin state) is reconstructable from the markdown alone.

**Why:** No vendor lock-in; the vault remains fully usable in any markdown editor even if Dome disappears. Out-of-band edits in Obsidian, vim, or git are tolerated because the markdown stays canonical. Sync mechanisms (v1+) can be markdown-native without coupling to Dome's runtime.

**Structural enforcement:** No SDK component holds canonical state in a database, a `.dome/cache/` file, or memory. Every read goes through the filesystem; every write mutates a markdown file. Plugins may cache for performance but must implement `rebuildFromVault(vault)` and the vault watcher invalidates caches on out-of-band changes.

**Counter-example:** A plugin stores entity relationships in `.dome/relations.sqlite` and serves queries from it without verifying against the markdown. Out-of-band Obsidian edits update markdown but not SQLite; queries return stale results. The fix: treat SQLite as a cache; rebuild from markdown on watcher events.

**Test guarantee:** `tests/invariants/markdown-is-source-of-truth.test.ts` — deletes the SDK's in-memory index, runs `rebuildIndex(vault)`, asserts the rebuilt index matches the pre-delete index byte-for-byte (modulo timestamps). Asserts every shipped SDK plugin has a `rebuildFromVault` method.

**Related:**
- [[wiki/specs/vault-layout]]
- [[wiki/concepts/brain-companion]]
- [[wiki/gotchas/out-of-band-vault-edits]]
