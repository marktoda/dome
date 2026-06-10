---
type: gotcha
created: 2026-05-27
updated: 2026-06-02
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
coverage: off-matrix
enforced_at: tests/extensions/loader.test.ts
first_observed: 2026-05-26 (v0.5 dailies-bundle phase)
severity: medium
---

# Extension bundle load order

**Symptom:** `openVault` fails with `bundle-load-failed` or `registry-build-failed` per [[wiki/specs/sdk-surface]] §"Bundle-loader error taxonomy". The user sees the failure with the bundle name or colliding key; the vault doesn't open.

**Root cause:** Two extension bundles declare the same identifier in a namespace where uniqueness is required. The five collision dimensions:

1. **`page-type-collision`** — two bundles declare `page-types.yaml extensions:` entries with the same `name:`. Or a bundle's page-type name collides with a vault-local declaration in `<vault>/.dome/page-types.yaml`.
2. **`duplicate-processor-id`** — two bundles register processors with the same fully qualified manifest id. First-party bundles use dotted bundle-prefixed ids such as `dome.daily.task-index`; third-party bundles should use the same convention.
3. **`external-handler-collision`** — two bundles register handlers for the same external capability (e.g., both `acme.calendar` and `widget.cal` register `calendar.write` handlers). The user must enable one or the other.
4. **`bundle-not-found`** — `.dome/config.yaml` enables a bundle id that is not present in the selected SDK-shipped plus vault-local root set. This usually means a typo, an uninstalled third-party bundle, or an exact `--bundles-root` override that excludes the bundle.
5. **`duplicate-command-trigger`** — two bundles register command-triggered view-phase processors with the same `triggers[].name` (the CLI surface name). Or one malformed view processor repeats the same command trigger.

**Structural mitigation:** **Fail-loud startup + namespaced manifest ids.**

1. **Bundle-name prefix on processor IDs.** The manifest id is fully qualified by convention. Two bundles with an `extract-capture` processor should declare ids such as `acme.intake.extract-capture` and `community.intake.extract-capture`.
2. **Deterministic composition.** Bundles load in alphabetical order within each root; normal CLI/runtime use then composes SDK-shipped and vault-local roots, with vault-local bundles overriding shipped bundles by id. The composed set is sorted by bundle id before registry construction.
3. **Fail-loud rejection.** The loader and registry do not silently skip a colliding or configured-missing bundle. `openVault` returns a structured `bundle-load-failed` or `registry-build-failed` error. The nested error names the colliding sources, missing bundle ids, or registry key.
4. **Test coverage:** `tests/extensions/loader.test.ts` covers loader-level collisions and `tests/processors/registry.test.ts` covers command-trigger uniqueness.

**Specific scenarios:**

- **Page-type collision.** A user installs `community.flashcards` (declares page-type `flashcard`) and `acme.notes-cards` (also declares `flashcard`). `openVault` fails with:
  ```text
  bundle-load-failed: page-type-collision
  Two bundles declare page-type 'flashcard':
    - community.flashcards (assets/extensions/community.flashcards/page-types.yaml)
    - acme.notes-cards (.dome/extensions/acme.notes-cards/page-types.yaml)
  Disable one in .dome/config.yaml or rename the conflict.
  ```

- **CLI command collision.** A bundle declares a view-phase processor with `triggers: [{ kind: "command", name: "lint" }]` — colliding with `dome.lint`. Runtime opening fails during registry validation with `duplicate-command-trigger`.

- **External handler collision.** Two bundles register `external-handlers/calendar.write.ts`. The user must pick one (disable the other in `.dome/config.yaml`).

- **Configured bundle missing.** `.dome/config.yaml` contains
  `extensions.community.advanced-recall.enabled: true`, but no selected root
  contains `community.advanced-recall/`. Runtime opening fails with
  `bundle-load-failed: bundle-not-found`; the message names the missing bundle
  id.

**Operational notes:**

- First-party `dome.*` bundles are guaranteed not to collide with each other (curated by the SDK team).
- Third-party bundle authors should namespace their page types and processor names to avoid collision (`acme.calendar.event`, not `event`).
- V1 manifests do not support a `deps:` field. If a bundle requires another
  bundle, document that requirement explicitly; future dependency support must
  preserve fail-loud activation.
- Bundle-load and registry-build failures surface from the command or runtime open that attempted to start the vault. A v1.x `dome doctor` invocation will run the same load-validation probe ahead of time as part of its check set in the deferred `dome.health` bundle.

**Related:**
- [[wiki/specs/sdk-surface]] §"Bundle-loader error taxonomy"
- [[wiki/specs/sdk-surface]] §"Bundle load lifecycle"
- [[wiki/matrices/extension-bundle-shape]]
