---
type: invariant
created: 2026-05-25
updated: 2026-05-25
sources: ["[[raw/original-architecture]]", "[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
tier: axiom
---

# RAW_IS_IMMUTABLE

**Tier:** Axiom — non-disable-able. Disabling it changes what Dome is.

**Statement:** Files under `<vault>/raw/` are immutable after creation. No Tool may modify a raw file. There are no exceptions.

**Why:** Trust in the synthesized wiki depends on knowing the inputs were not retroactively rewritten. If raw sources were mutable, the agent could revise its own "evidence" — a corruption surface that breaks provenance. The wiki cites raws; raws cite reality.

**Structural enforcement:** `writeDocument` and `moveDocument` both check `document.category` (derived from `path`) and refuse with `Result.err({ kind: 'invariant-violated', invariant: 'RAW_IS_IMMUTABLE' })` if the target is under `raw/`. There is no Tool that modifies raw file frontmatter; reverse references from raws to wiki pages are computed on demand from wiki frontmatter (via `dome doctor --show raw-citations`), not stored.

**Counter-example:** An agent attempts `writePage('raw/2026-05-25-voice-note.md', body, frontmatter)`. The Tool detects `category === 'raw'` and refuses. The Effect is `{ kind: 'invariant-violation', invariant: 'RAW_IS_IMMUTABLE', attempted_path: ... }`; the violation is logged but no mutation occurs.

**Test guarantee:** `tests/invariants/raw-is-immutable.test.ts` — for each mutating Tool, asserts that calling it with a `raw/...` path returns the invariant-violated error and the on-disk file is unchanged.

**Related:**
- [[wiki/specs/sdk-surface]] §"Tool catalog"
- [[wiki/specs/vault-layout]] §"Ownership rules"
- [[wiki/matrices/tool-invariant-enforcement]]
