---
type: invariant
created: 2026-07-18
updated: 2026-07-18
sources:
  - "[[cohesive/plans/2026-07-17-self-contained-distribution]]"
description: ContentScope is the deterministic upper bound on owner Markdown; exclusions and the Dome/Git private floor cannot be overridden and scope grants no capability
enforced_by:
  - tests/core/content-scope.test.ts
  - tests/invariants/content-scope-bounds-owner-markdown.test.ts
tier: axiom
---

# CONTENT_SCOPE_BOUNDS_OWNER_MARKDOWN

**Tier:** Axiom — non-disable-able.

**Statement:** A versioned ContentScope is the upper bound on owner Markdown
that a scope-aware Dome feature may treat as compiled knowledge. Only canonical
vault-relative paths ending in case-sensitive `.md` may enter. Exclusion wins,
and `.dome/**` plus `.git/**` are an unconditional private floor that no include
can override. Content scope grants no capability.

**Why:** Independent `wiki/**`, `notes/**`, and `**/*.md` universes let search,
Today, tasks, claims, briefs, graph, lint, and gardening disagree about what the
vault contains. A single upper bound makes adaptation reviewable without
turning layout policy into processor authority.

**Structural enforcement:** `src/core/content-scope.ts` is the only
ContentScope membership implementation. It canonicalizes paths through the
shared VaultPath constructor, gates lowercase Markdown, applies the private
floor and exclusions before includes, and returns a deterministic selection.
It imports only Node's trap-free Proxy detector, Zod, and the neutral path and
glob primitives. The matcher cache exists once at `src/core/glob-match.ts`;
the prior engine path is only a compatibility re-export.

The invariant test proves the non-overridable floors and structurally fences
the policy Module from engine, capability, filesystem, and Git imports. The
corpus tests pin version-1 Bun.Glob semantics, malformed input, canonical
ordering, duplicate elimination, bounded hostile-input handling, literal
metacharacters, and deterministic selection.

Policy persistence is resolved through one document seam. A fresh vault may
carry `content_scope` inline in `.dome/config.yaml`; adaptation of an older
valid config may carry it in the create-only `.dome/content-scope.yaml`
overlay. Orphaned overlays and unequal dual definitions fail closed, so the
two storage shapes cannot produce two content universes.

**Counter-example:** A processor enumerates `wiki/**/*.md` directly even
though the vault scope excludes `wiki/private/**`, or treats an include of
`.dome/**/*.md` as authority to read operational state. Both violate the upper
bound. The processor must receive paths already narrowed by ContentScope and
still pass its independent capability checks.

**Rollout status:** The policy contract, mechanical floors, setup compiler,
and runtime config loading ship now through the same canonical schema.
First-party processor adoption is a subsequent M4 checkpoint tracked in the
distribution plan. Until that migration completes, the invariant applies to
consumers of the ContentScope Module; the plan's acceptance gate separately
removes every independent first-party universe.
The temporary engine matcher re-export is removed at the final M4 checkpoint
after all imports move to the neutral seam.

**Related:**
- [[wiki/specs/content-scope]]
- [[wiki/specs/capabilities]]
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]]
