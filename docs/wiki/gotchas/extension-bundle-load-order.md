---
type: gotcha
created: 2026-05-26
updated: 2026-05-26
sources: ["[[cohesive/brainstorms/2026-05-26-dome-hooks-v1-roadmap]]"]
severity: medium
coverage: off-matrix
enforced_at: tests/integration/extension-bundles-load.test.ts
first_observed: 2026-05-26
---

# Extension bundle load order

**Symptom:** Two extension bundles each declare a page type with the same name (or two preamble fragments contradict each other). A user installs both bundles; one silently overrides the other based on load order. Reads from the masked page type — or `dome doctor --repair` regenerating an AGENTS.md preamble — reflect whichever bundle loaded *second* (or whichever sorted last alphabetically), without naming the conflict anywhere.

**Root cause:** Extension bundles in `<vault>/.dome/extensions/<name>/` load alphabetically by directory name during `openVault`. The bundle loader merges each bundle's `page-types.yaml extensions:` block, `preamble.md` fragment, `workflows/*.md`, `hooks/*.yaml`, `cli/*.ts`, and `tools/*.ts` into the vault's registries in load order. A name collision between two bundles' contributions — most commonly a duplicate page-type name or two preamble fragments that document conflicting conventions for the same page type — is treated as last-write-wins at the registry layer; no warning is emitted at load time.

Three surfaces are affected:

- **Page-type registry** (`PageTypesConfig.extensions`): a duplicate `name:` in two bundles results in the later bundle's `frontmatter_extras` shadowing the earlier; `writeDocument` validates against the shadow, not the original.
- **AGENTS.md templated section** (`buildAgentsMdTemplated`'s `## Extension conventions` block): preamble fragments are concatenated in load order. Two fragments documenting incompatible conventions both appear; an agent reading them in order experiences contradictory instructions and may follow either.
- **Hook registry** (`HookRegistry.register`): two hooks with the same `id` (the bundle-namespaced handler key) collide. v0.5 throws on collision because hook IDs are bundle-prefixed (`<bundle>:<hook-filename>`), so a collision within one bundle is detectable; cross-bundle prefix collision is structurally impossible by construction.

**Severity:** Medium. The page-type and preamble cases are silent; the hook case is loud (throws). A user with two well-meaning bundles can land in a state where their vault behaves differently from what either bundle's docs claim, and the conflict is invisible until they observe the behavior drift.

**Structural mitigation:** Two parts:

1. **Hook-ID namespacing** is structural — `HookRegistry.register` enforces unique IDs, and the bundle loader prepends `<bundle>:` to every hook filename before registration. A bundle author can't accidentally pick a colliding hook ID.

2. **Page-type and preamble collisions** are caught by the lockstep test at `tests/integration/extension-bundles-load.test.ts`. The test loads a fixture vault with two bundles declaring the same page type and asserts the loader rejects the load per the bundle-loader error taxonomy in [[wiki/specs/sdk-surface]] §"Bundle-loader error taxonomy" — `openVault` returns `Result.err({ kind: 'bundle-load-failure', detail: 'page-type-collision', message: '<bundle-a> and <bundle-b> both declare page type "<name>"' })`. The fail-loud default is the right call because the v0.5 user (Mark first, dogfood-extending out) is hand-installing bundles and benefits from immediate feedback.

The preamble-fragment case is treated identically — duplicate page-type declarations between bundles are the proxy for "these bundles describe the same domain", and the rejection covers both. Bundles that intentionally extend the *same* page type's frontmatter without redeclaring the name are a v0.5.1+ extension semantic; v0.5 treats redeclaration as collision.

**Specific scenarios:**

- A user installs `dailies` (the first-party Phase 1 bundle) and a hypothetical community `journal` bundle that also declares `wiki/dailies/`. `openVault` rejects with a `bundle-load-failure` naming both bundles; the user picks one.

- A user installs `aggregation` (a hypothetical Phase 3 bundle) that declares `wiki/weeklies/` and a community `weekly-review` bundle that also declares `wiki/weeklies/`. Same rejection shape.

- A user updates one bundle to v2, which renames its contributed page type from `daily` to `journal-entry`. Existing files in `wiki/dailies/` are now type-orphaned (no bundle declares them). `dome doctor` reports the orphan; the user runs `dome lint` to migrate or delete.

**Related:**

- [[wiki/specs/sdk-surface]] §"Extension bundles" — the bundle mechanism that fails loudly on collision.
- [[wiki/matrices/extension-bundle-shape]] — the five-kind contribution surface bundles use.
- [[wiki/specs/vault-layout]] §"Vault root" — the `.dome/extensions/<bundle>/` location.
- [[wiki/gotchas/substrate-count-drift]] — adjacent pattern (substrate-vs-code drift); bundles can drift the same way when a bundle's `page-types.yaml` and `preamble.md` get out of sync internally.
