---
type: invariant
created: 2026-05-27
updated: 2026-05-29
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
tier: axiom
---

# RAW_IS_IMMUTABLE

**Tier:** Axiom — non-disable-able. Disabling it changes what Dome is.

**Statement:** Files under `<vault>/raw/` are immutable after creation. No `PatchEffect` is applied to a `raw/` path. There are no exceptions.

**Implementation status:** Axiom target, not fully enforced in the current v1 engine. The shipped default grants do not authorize raw writes, so normal first-party processors cannot patch `raw/**`, but the broker does not yet contain a raw-specific hard deny and `dome.markdown.raw-immutable` is not shipped. Treat the two-layer enforcement below as the required implementation plan until the broker rule, adoption processor, and harness tests land.

**Why:** Trust in the synthesized wiki depends on knowing the inputs were not retroactively rewritten. If raw sources were mutable, processors could revise their own "evidence" — a corruption surface that breaks the SourceRef-to-evidence guarantee in [[wiki/specs/effects]] §"The SourceRef type". The wiki cites raws via SourceRefs; raws cite reality.

**Target structural enforcement:** Two-layer:

1. **The capability broker refuses `patch.auto` and `patch.propose` grants on `raw/**`.** The shipped-default `<vault>/.dome/config.yaml` carries no extension grant for raw-write; manifests requesting it are accepted at bundle load (declarations are informational) but the broker rejects the resulting effect at emission time with `code: "capability-deny-patch", message: "raw/ is immutable"`.
2. **The `dome.markdown` adoption-phase processor emits a blocking diagnostic on any Proposal whose changed-path set includes a `raw/` mutation** (deletion, modification, or new-content-into-existing-file). The diagnostic surfaces during `dome sync` / `dome serve` adoption with severity `block`; adoption refuses to advance until the user reverts the raw change.

Together: the broker layer protects against well-behaved processors emitting forbidden effects; the dome.markdown adoption check protects against a user (or agent) directly writing to a raw file in the working tree and then submitting.

**Counter-example:** A garden-phase processor wants to "correct a typo" in a raw voice transcript and emits `PatchEffect { kind: "patch", mode: "auto", patch: <diff>, ...}` targeting `raw/voice/2026-05-27-meeting.md`. The broker's `patch.auto` grant for the processor names `wiki/**`, not `raw/**`. The effect is denied with a capability diagnostic; the processor's RunRecord records the denial via the `capability_uses` ledger row.

Alternatively: the user opens `raw/voice/2026-05-27-meeting.md` in vim, edits it, and commits the edit. The next `dome sync` constructs a Proposal whose changed-paths include the raw modification. `dome.markdown.raw-immutable` runs in the adoption phase, emits a blocking diagnostic, adoption refuses to advance. The user must `git restore raw/voice/2026-05-27-meeting.md` and commit the revert.

**Required test guarantee:** `tests/invariants/raw-is-immutable.test.ts` should cover two cases once enforcement ships. (1) A fixture processor emits a PatchEffect against `raw/example.md`; assert the broker denies the effect with `code: "capability-deny-patch"`. (2) A fixture vault has a committed modification to `raw/example.md`; `dome sync` returns `adopted: false` with a `raw.immutable` blocking diagnostic naming the path. The current test is only an AC3 doc-existence stub.

**Related:**
- [[wiki/specs/effects]] §"PatchEffect"
- [[wiki/specs/capabilities]] §"patch.auto"
- [[wiki/specs/vault-layout]] §"`raw/` — immutable raw captures"
- [[wiki/matrices/effect-x-capability]] — the per-Effect-kind capability requirement table
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]] — the broker chokepoint
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] — the write-path chokepoint
