---
type: gotcha
created: 2026-05-27
updated: 2026-05-27
severity: medium
coverage: off-matrix
enforced_at: src/extensions/loader.ts
first_observed: 2026-05-26 (v0.5 dailies-bundle phase)
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# Extension bundle load order

**Symptom:** `openVault` fails with `bundle-load-failure { detail: "<discriminator>" }` per [[wiki/specs/sdk-surface]] §"Bundle-loader error taxonomy". The user sees the failure with the bundle name and the colliding key; the vault doesn't open.

**Root cause:** Two extension bundles declare the same identifier in a namespace where uniqueness is required. The five collision dimensions:

1. **`page-type-collision`** — two bundles declare `page-types.yaml extensions:` entries with the same `name:`. Or a bundle's page-type name collides with a vault-local declaration in `<vault>/.dome/page-types.yaml`.
2. **`processor-collision`** — two bundles register a processor with the same id (without the bundle-prefix). The loader auto-prefixes (`<bundle>:<processor-id>`), so true id collision is rare — but if a bundle's `manifest.yaml` declares an id of the form `<other-bundle>:foo`, the loader rejects it.
3. **`capability-handler-collision`** — two bundles register handlers for the same external capability (e.g., both `acme.calendar` and `widget.cal` register `calendar.write` handlers). The user must enable one or the other.
4. **`bundle-deps-unmet`** — a bundle's `deps:` block names a bundle not present in `<vault>/.dome/extensions/`. The bundle that depends on the missing one fails to load.
5. **`cli-command-collision`** — two bundles register command-triggered view-phase processors with the same `triggers[].name` (the CLI surface name). Or a bundle's CLI name collides with a shipped CLI command.

**Structural mitigation:** **Fail-loud at load time + bundle-name auto-prefix.**

1. **Bundle-name prefix on processor IDs.** The loader registers processors as `<bundle-name>:<processor-id>` automatically. Two bundles with a processor named `extract-capture` get IDs `dome.intake:extract-capture` and `community.intake:extract-capture` — no collision.
2. **Alphabetical load order.** Bundles load in alphabetical order of directory name within each tier (first-party `dome.*` first; then vault-local + third-party alphabetical). Predictable ordering means cross-bundle collisions surface at the same place every time.
3. **Fail-loud rejection.** The loader does not silently skip a colliding bundle — `openVault` returns `Result.err({ kind: "bundle-load-failure", detail: ..., message: ... })`. The error message names both colliding sources and the colliding key.
4. **Test coverage:** `tests/integration/extension-bundle-load-order.test.ts` exercises each collision dimension with fixture bundles, asserts the right discriminator surfaces.

**Specific scenarios:**

- **Page-type collision.** A user installs `community.flashcards` (declares page-type `flashcard`) and `acme.notes-cards` (also declares `flashcard`). `openVault` fails with:
  ```text
  bundle-load-failure: page-type-collision
  Two bundles declare page-type 'flashcard':
    - community.flashcards (assets/extensions/community.flashcards/page-types.yaml)
    - acme.notes-cards (.dome/extensions/acme.notes-cards/page-types.yaml)
  Disable one in .dome/config.yaml or rename the conflict.
  ```

- **CLI command collision.** A bundle declares a view-phase processor with `triggers: [{ kind: "command", name: "lint" }]` — colliding with `dome.lint`. The loader rejects the bundle with `cli-command-collision`.

- **Capability handler collision.** Two bundles register `external-handlers/calendar.write.ts`. The user must pick one (disable the other in `.dome/config.yaml`).

- **Cross-bundle dependency unmet.** `community.advanced-recall` depends on `community.basic-recall`. The user installs only the former. Load fails with `bundle-deps-unmet`; the message names the missing dep.

**Operational notes:**

- First-party `dome.*` bundles are guaranteed not to collide with each other (curated by the SDK team).
- Third-party bundle authors should namespace their page types and processor names to avoid collision (`acme.calendar.event`, not `event`).
- Bundle-load failures surface as engine-emitted DiagnosticEffects (`code: "bundle-load-failure"`, with the colliding-key detail in `message`) and are visible via `dome show diagnostics`. A v1.x `dome doctor` invocation will run the same load-validation probe ahead of time as part of its check set in the deferred `dome.health` bundle.

**Related:**
- [[wiki/specs/sdk-surface]] §"Bundle-loader error taxonomy"
- [[wiki/specs/sdk-surface]] §"Bundle load lifecycle"
- [[wiki/matrices/extension-bundle-shape]]
