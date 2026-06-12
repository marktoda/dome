---
type: invariant
created: 2026-05-27
updated: 2026-06-11
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
description: "Files under raw/ never change after creation: the broker denies raw-targeting patches and dome.markdown.raw-immutable blocks committed edits"
enforced_by:
  - tests/invariants/raw-is-immutable.test.ts
  - tests/engine/capability-broker.test.ts
tier: axiom
---

# RAW_IS_IMMUTABLE

**Tier:** Axiom — non-disable-able. Disabling it changes what Dome is.

**Statement:** Files under `<vault>/raw/` are immutable after creation. No `PatchEffect` is applied to a `raw/` path. There are no exceptions.

**Implementation status:** Shipped in v1. The capability broker hard-denies any `PatchEffect` touching `raw/**`, and the first-party `dome.markdown.raw-immutable` adoption processor blocks committed user/agent mutations to existing raw files.

**Why:** Trust in the synthesized wiki depends on knowing the inputs were not retroactively rewritten. If raw sources were mutable, processors could revise their own "evidence" — a corruption surface that breaks the SourceRef-to-evidence guarantee in [[wiki/specs/effects]] §"The SourceRef type". The wiki cites raws via SourceRefs; raws cite reality.

**Structural enforcement:** Two-layer:

1. **The capability broker refuses `patch.auto` and `patch.propose` writes to `raw/**`.** Even if a processor declares and is granted broad patch reach, the broker rejects a raw-targeting effect at emission time with `code: "capability-deny-patch"` and a message containing `raw/ is immutable`.
2. **The `dome.markdown.raw-immutable` adoption-phase processor emits a blocking diagnostic on any Proposal whose changed-path set includes a `raw/` mutation** (deletion or modification of an existing raw file). The diagnostic surfaces during `dome sync` / `dome serve` adoption with severity `block`; adoption refuses to advance until the user reverts the raw change. Creating new raw files by ordinary git commit is allowed; mutating them after creation is not.

Together: the broker layer protects against well-behaved processors emitting forbidden effects; the dome.markdown adoption check protects against a user (or agent) directly writing to a raw file in the working tree and then submitting.

**Counter-example:** A garden-phase processor wants to "correct a typo" in a raw voice transcript and emits `PatchEffect { kind: "patch", mode: "auto", patch: <diff>, ...}` targeting `raw/voice/2026-05-27-meeting.md`. The broker's `patch.auto` grant for the processor names `wiki/**`, not `raw/**`. The effect is denied with a capability diagnostic; the processor's RunRecord records the denial via the `capability_uses` ledger row.

Alternatively: the user opens `raw/voice/2026-05-27-meeting.md` in vim, edits it, and commits the edit. The next `dome sync` constructs a Proposal whose changed-paths include the raw modification. `dome.markdown.raw-immutable` runs in the adoption phase, emits a blocking diagnostic, adoption refuses to advance. The user must `git restore raw/voice/2026-05-27-meeting.md` and commit the revert.

**Test guarantee:** `tests/invariants/raw-is-immutable.test.ts` covers broker denial for auto/propose raw patches, committed raw modification blocking with a `raw.immutable` diagnostic, and committed raw creation remaining adoptable.

**Related:**
- [[wiki/specs/effects]] §"PatchEffect"
- [[wiki/specs/capabilities]] §"patch.auto"
- [[wiki/specs/vault-layout]] §"`raw/` — immutable raw captures"
- [[wiki/matrices/effect-x-capability]] — the per-Effect-kind capability requirement table
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]] — the broker chokepoint
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] — the write-path chokepoint
