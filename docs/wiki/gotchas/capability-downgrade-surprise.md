---
type: gotcha
created: 2026-05-27
updated: 2026-05-27
severity: low
coverage: tested
enforced_at: src/engine/capability-broker.ts
first_observed: 2026-05-27 (anticipated; surfaced in v1 design)
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# Capability downgrade surprise

**Symptom:** A processor declared `patch.auto: ["wiki/**"]` in its manifest, but at runtime some of its auto-patches surface in `dome lint`'s review queue (as proposed patches) instead of applying directly. The user is confused — they thought the processor was a trusted auto-patcher.

**Root cause:** The vault's `<vault>/.dome/config.yaml` grants the processor only `patch.auto: ["wiki/dailies/**"]`, not the full `wiki/**` the manifest requested. The capability broker enforces the **intersection** of declared and granted, so auto-patches to paths outside `wiki/dailies/**` are downgraded to `mode: "propose"` and emit a `capability-downgrade-surprise` diagnostic.

**Structural mitigation:** **Diagnostic on every downgrade + visible review queue.**

Per [[wiki/specs/effects]] §"PatchEffect" and [[wiki/matrices/effect-x-capability]]: a PatchEffect with `mode: "auto"` exceeding `patch.auto` grant for any touched path is rewritten to `mode: "propose"`. A `DiagnosticEffect { code: "capability-downgrade-surprise" }` is emitted alongside:

```text
severity: "warning"
code: "capability-downgrade-surprise"
message: "Processor <id> emitted patch.auto for paths exceeding its grant; downgraded to patch.propose."
sourceRefs: [<patched paths>]
```

The diagnostic surfaces:
- In `dome submit`'s output for the current Proposal (with severity warning, not blocking).
- In `dome doctor --show diagnostics --code capability-downgrade-surprise`.
- In the next `dome lint` report (the downgraded patch becomes a proposed finding the user reviews).

The user resolves by either:
1. **Granting wider scope** in `<vault>/.dome/config.yaml`:
   ```yaml
   extensions:
     acme.intake:
       grants:
         patch.auto: ["wiki/**"]   # widened from wiki/dailies/**
   ```
2. **Accepting the propose-mode flow** — reviewing the patches via `dome lint --apply <id>` as they accumulate.

**Specific scenarios:**

- **Conservative default grants.** First-party `dome.intake` ships with default grant `patch.auto: ["wiki/generated/intake/**", "inbox/processed/**"]`. A user who wants the intake to write directly into `wiki/entities/**` (auto-mode) widens the grant. Until then, every intake-derived patch to wiki/entities lands in the review queue.

- **Third-party bundle with broad ask.** `community.heavy-linter` requests `patch.auto: ["**"]` in its manifest. The user installs it; the bundle loads (the manifest is valid); but the user has not granted `patch.auto: ["**"]` in `config.yaml` (default is empty). Every auto-patch the bundle emits gets downgraded to propose. The user sees a stream of warning diagnostics; reads the bundle's preamble.md to understand what it does; then either grants the full reach or removes the bundle.

- **Region ownership conflict.** `dome.daily.create-daily` emits a patch touching `wiki/dailies/2026-05-27.md` (a path it's granted `patch.auto` for). The same patch also touches a region owned by `acme.todo-tracker` (`owns.region: ["acme.todo-tracker.today"]`). The patch is downgraded because of the region-ownership violation, not the path-grant — the diagnostic message names the region owner explicitly.

**Operational notes:**

- The downgrade is **safe by default** — surprise is preferred to silent over-reach.
- A processor that *needs* auto-mode (e.g., the engine's closure-commit machinery) doesn't emit PatchEffects through this path; the engine writes directly within its own boundary.
- Bundle authors who want their auto-patches to apply should declare narrow `patch.auto` paths in their manifest (matching what they actually need), making the default grant in `config.yaml` correspondingly narrow and visible.

**Related:**
- [[wiki/specs/capabilities]] §"patch.auto"
- [[wiki/specs/effects]] §"PatchEffect"
- [[wiki/matrices/effect-x-capability]]
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]]
