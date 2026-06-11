---
type: invariant
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
tier: axiom
enforced_by:
  - tests/integration/no-direct-mutation-outside-boundaries.test.ts
  - tests/engine/apply-effect.test.ts
---

# ALL_MUTATION_GOES_THROUGH_ADOPTION

**Tier:** Axiom — non-disable-able.

**Statement:** Every change to trusted vault state — agent's native `Write`, vim save, Obsidian edit, `git commit`, `dome sync`, garden processor's PatchEffect, scheduled cron processor's auto-patch — eventually flows through the engine's adoption loop. Vault state outside the adopted ref is *draft state*; it becomes trusted only when adopted.

This invariant replaces v0.5's `VAULT_RECONCILES_AFTER_NATIVE_WRITE`. The shape generalized: v0.5 distinguished "Tool-mediated writes" (synchronously through Tools + hooks) from "native writes" (caught by the watcher, replayed by `dome reconcile`); v1 unifies — every write produces a Proposal, every Proposal runs through the adoption loop. No bifurcation.

**Why:** A single adoption path is the structural guarantee behind every other engine property — capability enforcement, diagnostics, ledgering, projection updates. A bypass would create state Dome cannot reason about: changes that are neither rejected nor recorded, just *there*.

**Structural enforcement:**

1. **The compiler host turns branch movement into a Proposal.** `dome serve` polls `refs/heads/<branch>` against `refs/dome/adopted/<branch>`; when HEAD advances, it constructs a manual-source Proposal internally via `makeManualProposal`. The Proposal source kind is set to `manual` with the active branch (per [[wiki/specs/proposals]] §"Local-eventual mode").
2. **`dome sync` is the one-shot catch-up path.** When `dome serve` is off, native writes and git commits accumulate as draft state ahead of adopted. The next `dome sync` catches them up — the "draft state ahead of adopted" property per [[wiki/specs/adoption]].
3. **The engine itself does not produce changes outside adoption.** Garden processors that emit PatchEffects don't write directly — they re-enter as new Proposals per [[wiki/specs/proposals]] §"Garden-emitted Proposals".
4. **`refs/dome/adopted/<branch>` is the trust boundary.** Code reading "trusted state" reads the adopted ref, never HEAD. Pinned by [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]].

**Counter-example:** A user runs `git commit` manually for three changes while `dome serve` is off. HEAD is now three commits ahead of adopted, so the three commits sit in *draft state*. The next `dome sync` constructs a Proposal `adopted..HEAD` and runs the adoption loop. The three commits adopt together as one Proposal. State is correct; the catch-up happens at the user's invocation.

If the user never runs `dome sync` and never starts `dome serve`, the three commits remain draft. `dome status` shows `pending: 3 commits to adopt`. Recall queries default to adopted state and don't see the draft commits. This is by design — draft state is the user's space; trusted state is the engine's.

**Test guarantee:** `tests/invariants/all-mutation-goes-through-adoption.test.ts` — for each write path (working-tree edit + git commit; agent `Write` + git commit; `dome sync`; garden PatchEffect), asserts the change either reaches adoption directly through the compiler-host/sync path or accumulates as draft state visible to the next sync.

**Related:**
- [[wiki/specs/adoption]]
- [[wiki/specs/proposals]]
- [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]]
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]]
- [[wiki/gotchas/daemon-off-while-vault-mutating]]
- [[wiki/gotchas/out-of-band-vault-edits]]
