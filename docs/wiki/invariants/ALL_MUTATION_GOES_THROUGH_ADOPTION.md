---
type: invariant
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
tier: axiom
---

# ALL_MUTATION_GOES_THROUGH_ADOPTION

**Tier:** Axiom — non-disable-able.

**Statement:** Every change to vault state — agent's native `Write`, vim save, Obsidian edit, `dome submit`, garden processor's PatchEffect, scheduled cron processor's auto-patch — eventually flows through the engine's adoption loop. Vault state outside the adopted ref is *draft state*; it becomes trusted only when adopted.

This invariant replaces v0.5's `VAULT_RECONCILES_AFTER_NATIVE_WRITE`. The shape generalized: v0.5 distinguished "Tool-mediated writes" (synchronously through Tools + hooks) from "native writes" (caught by the watcher, replayed by `dome reconcile`); v1 unifies — every write produces a Proposal, every Proposal runs through the adoption loop. No bifurcation.

**Why:** A single adoption path is the structural guarantee behind every other engine property — capability enforcement, diagnostics, ledgering, projection updates. A bypass would create state Dome cannot reason about: changes that are neither rejected nor recorded, just *there*.

**Structural enforcement:**

1. **The working-tree watcher turns every native write into a Proposal.** `src/watcher.ts` consumes chokidar events; on each write, the watcher debounces, then calls `vault.submitProposal()`. The Proposal source kind is set to the inferred originator (per the source-inference rules in [[wiki/specs/proposals]] §"Local-eventual mode").
2. **`dome serve` runs the watcher.** When `dome serve` is off, native writes accumulate in the working tree without immediate adoption. The next `dome submit` / `dome sync` catches them up — the "draft state ahead of adopted" property per [[wiki/specs/adoption]].
3. **The engine itself does not produce changes outside adoption.** Garden processors that emit PatchEffects don't write directly — they re-enter as new Proposals per [[wiki/specs/proposals]] §"Garden-emitted Proposals".
4. **`refs/dome/adopted/<branch>` is the trust boundary.** Code reading "trusted state" reads the adopted ref, never HEAD. Pinned by [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]].

**Counter-example:** A user runs `git commit` manually for three changes without invoking `dome submit`. HEAD is now three commits ahead of adopted. The watcher (if running) doesn't react to git commits — only to working-tree changes — so the three commits sit in *draft state*. The next `dome submit` / `dome sync` constructs a Proposal `adopted..HEAD` and runs the adoption loop. The three commits adopt together as one Proposal. State is correct; the catch-up happens at the user's invocation.

If the user never runs `dome submit`, the three commits remain draft. `dome status` shows `pending: 3 commits to adopt`. Recall queries default to adopted state and don't see the draft commits. This is by design — draft state is the user's space; trusted state is the engine's.

**Test guarantee:** `tests/invariants/all-mutation-goes-through-adoption.test.ts` — for each of the four write paths (working-tree edit; agent `Write`; `dome submit`; garden PatchEffect), asserts the change either reaches adoption directly (via `dome submit`) or accumulates as draft state visible to the next sync.

**Related:**
- [[wiki/specs/adoption]]
- [[wiki/specs/proposals]]
- [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]]
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]]
- [[wiki/gotchas/daemon-off-while-vault-mutating]]
- [[wiki/gotchas/out-of-band-vault-edits]]
