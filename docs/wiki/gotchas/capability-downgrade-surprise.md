---
type: gotcha
created: 2026-05-27
updated: 2026-05-29
severity: low
coverage: off-matrix
enforced_at: src/engine/capability-broker.ts
enforced_at_status: implemented
first_observed: 2026-05-27 (anticipated; surfaced in v1 design)
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# Capability downgrade surprise

**Symptom:** A processor declared `patch.auto: ["wiki/**"]` in its manifest, but at runtime some of its auto-patches are downgraded to proposed patches instead of applying directly. In adoption this blocks the Proposal for review; in async/review-queue flows the patch surfaces for explicit user approval. The user is confused — they thought the processor was a trusted auto-patcher.

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
- In `dome sync` / `dome serve` output for the current Proposal, followed by a block diagnostic `patch.propose.requires-review` when this happens inside adoption.
- In `dome inspect diagnostics --code capability-downgrade-surprise`.
- In the relevant review surface (for example the future lint/review queue) when the downgraded patch is presented for approval.

The user resolves by either:
1. **Granting wider scope** in `<vault>/.dome/config.yaml`:
   ```yaml
   extensions:
     acme.intake:
       grants:
         patch.auto: ["wiki/**"]   # widened from wiki/dailies/**
   ```
2. **Accepting the propose-mode flow** — reviewing the proposed patch once the v1.x review/apply queue lands. In v1.0, adoption-phase propose-mode patches block because no CLI apply surface is shipped.

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
