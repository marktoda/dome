---
type: invariant
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
tier: shipped-default
---

# PAGE_TYPE_BY_DIRECTORY

**Tier:** Shipped default — enabled in every vault; can be disabled in `.dome/config.yaml` for vaults that prefer a flat `wiki/` (rare; useful only for very small vaults).

**Statement:** A wiki page's type is the immediate subdirectory of `wiki/` that contains it. `wiki/entities/danny.md` has `type: entity`. `wiki/concepts/llm-wiki-pattern.md` has `type: concept`. Allowed types are declared in `<vault>/.dome/page-types.yaml` (defaults ∪ extensions).

**Why:** The directory structure is the type system. This is contrarian in the PKM space — most tools use frontmatter or tags as the primary type signal — but the directory has two properties tags can't match: (1) it's visible in any markdown editor; (2) it's a grep-friendly stable target. The frontmatter `type:` field is a redundant self-documenting check; the directory is canonical.

**Structural enforcement:** `writePage(path, ...)` parses `path`, extracts the directory immediately under `wiki/`, and checks against the allowed-types list from `page-types.yaml`. Writes to unknown subdirectories (e.g., `wiki/decisions/`) are rejected. Writes to allowed subdirectories must carry a matching `type:` frontmatter value or the Tool rejects with `kind: 'frontmatter-mismatch'`.

**Counter-example:** A new contributor decides "decision" deserves its own page type and starts writing `wiki/decisions/atlas-platform-split.md`. Without an entry in `page-types.yaml`, `writePage` refuses. The right path: add `decisions` to the `extensions:` block in `.dome/page-types.yaml`; declare any per-type frontmatter schema; then writes succeed. The decision to expand the type system is explicit and vault-scoped, not accidental.

**Counter-example #2:** A page at `wiki/entities/danny.md` carries `type: concept` in its frontmatter (typo). The directory says entity; the frontmatter says concept. `writePage` rejects with `kind: 'frontmatter-mismatch'`; the directory wins. `dome doctor` reports any pre-existing pages with this drift.

**Test guarantee:** `tests/invariants/page-type-by-directory.test.ts` — for each default page type, asserts `writePage` accepts a matching directory + frontmatter pair. Asserts it rejects unknown subdirectories. Asserts it rejects directory/frontmatter mismatches. Asserts `dome doctor` reports both kinds of drift.

**Related:**
- [[wiki/specs/page-schema]]
- [[wiki/specs/vault-layout]] §"Type derivation"
- [[wiki/specs/sdk-surface]] §"The four concepts"
- [[wiki/gotchas/out-of-band-vault-edits]]
