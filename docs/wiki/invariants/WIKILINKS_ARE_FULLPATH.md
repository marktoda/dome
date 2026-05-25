---
type: invariant
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
tier: shipped-default
---

# WIKILINKS_ARE_FULLPATH

**Tier:** Shipped default — enabled in every vault; can be disabled in `.dome/config.yaml` for small vaults where collision risk is low and Obsidian-style short links are preferred.

**Statement:** Wikilinks in page bodies use the full path from vault root: `[[wiki/entities/danny]]`, not `[[danny]]`. `wikilinkResolve` resolves only full-path links; ambiguous short-form links return `null`.

**Why:** Two-name collisions in a real vault are the norm, not the exception (multiple "Mark"s, "Atlas" as both project and Greek figure). Short-form wikilinks force the system to disambiguate at resolve time — slow, fragile, easy-to-get-wrong. Full-path wikilinks are grep-friendly (`grep -r "wiki/entities/danny" docs/`), are unambiguous, and work identically in Obsidian when the vault is configured for "absolute paths" (a single setting).

**Structural enforcement:** `writeDocument` parses the body for wikilinks and rejects any short-form link with `kind: 'wikilink-not-fullpath'`, naming the offending link. The error message suggests the resolution (e.g., "did you mean `[[wiki/entities/danny]]`?"). `wikilinkResolve` accepts only full-path input; short-form input returns `null`.

**Counter-example:** During ingest, the agent emits `[[Danny]]` in the body of a new page. `writeDocument` rejects. The agent re-tries with `[[wiki/entities/danny]]`. The page commits. Future readers can grep for entity references unambiguously.

**Counter-example #2:** A user hand-edits a page in Obsidian and uses Obsidian's short-form `[[Danny]]` syntax. Dome tolerates this (Obsidian writes are out-of-band; see [[wiki/gotchas/out-of-band-vault-edits]]) but `dome doctor` flags the page, and the next Dome-tool write to that page fails until the wikilinks are normalized. The user's editor is recommended to set "Default link format: absolute path in vault" to avoid this.

**Test guarantee:** `tests/invariants/wikilinks-are-fullpath.test.ts` — asserts `writeDocument` rejects pages whose body contains short-form wikilinks. Asserts `wikilinkResolve` returns `null` for short-form input. Asserts `dome doctor` reports short-form links and suggests the full path.

**Related:**
- [[wiki/specs/sdk-surface]] §"Tool catalog" (`wikilinkResolve`, `writeDocument`)
- [[wiki/specs/page-schema]] §"Body conventions"
- [[wiki/entities/obsidian]] §"Recommended settings"
