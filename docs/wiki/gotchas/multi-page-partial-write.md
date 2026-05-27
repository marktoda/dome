---
type: gotcha
created: 2026-05-27
updated: 2026-05-27
severity: low
coverage: tested
enforced_at: src/engine/adopt.ts
first_observed: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# Multi-page partial write

**Symptom:** A garden-phase processor produces a PatchEffect touching seven pages — five updates and two new pages. The engine constructs a Proposal from the patch, but adoption blocks midway (the engine crashes, the user kills the process, a diagnostic on the fifth page surfaces). The vault is in a partially-mutated state — some pages reflect the new content, others don't.

**Status under v1:** **Adoption is atomic; this failure mode is now structurally prevented for engine-applied changes.** The failure mode survives for two narrow cases: (a) user-driven multi-file edits in the working tree before submission, and (b) interrupted adoption *before* the closure commit lands.

**Root cause (historical and remaining):** Multi-page changes are now expressed as a single PatchEffect (or multiple PatchEffects in one Proposal). The engine's adoption loop applies them to a candidate tree; only when the fixed point is reached and capability/diagnostic checks pass does the engine commit (the "closure commit" per [[wiki/specs/adoption]] §"The fixed-point adoption loop"). If adoption blocks, the candidate tree is discarded; the working tree may still hold user-staged changes, but the adopted ref does NOT advance.

The narrow remaining cases:

1. **Engine crash between writing the closure-commit blob objects and updating the adopted ref.** Atomic at the git-object level (git's content-addressed store survives crashes), but the ref-update is the structural boundary; if the process dies mid-update, the ref stays at the prior commit and the new commit becomes an unreachable object eligible for GC. **Recovery:** zero work — the next `dome sync` rebuilds the candidate from `adopted..HEAD` and resubmits. The orphan engine commit is eventually garbage-collected by `git gc` (or by `dome doctor --gc-orphan-engine-commits`).

2. **User editing multiple files in the working tree, then crashing or interrupting before `dome submit`.** The working tree has half-edited files; adoption never started. **Recovery:** the user runs `dome status` to see the dirty-tree count, decides whether to commit-and-submit or `git restore` to undo.

**Structural mitigation:** **The closure commit is the atomic boundary.**

Per [[wiki/specs/adoption]] §"The fixed-point adoption loop":

```
for iteration in 1..MAX_ITER:
  candidate = apply_patches(candidate, ...)
if candidate != P.head:
  closureCommit = commitWorkflow({ candidate, runContext })
setAdoptedRef(branch, closureCommit ?? P.head)
```

The `commitWorkflow` call produces a single git commit object atomically (git's write-tree + write-commit are atomic-ish via filesystem rename). `setAdoptedRef` is the single ref-update. If either step fails, the prior adopted ref stays unchanged; the user's intent is recoverable via `git status` + resubmit.

**Specific scenarios:**

- **Garden processor produces a 7-file PatchEffect; the 5th file emits a blocking diagnostic during adoption.** The engine aborts adoption *before* writing the closure commit. The candidate tree (held in-memory) is discarded. The user sees `dome submit` exit 1 with the diagnostic. No on-disk partial state — the working tree is unchanged from before submit.

- **User edits 7 files in vim; runs `dome submit`; the engine crashes mid-loop.** The candidate-tree work is lost (no harm — it was in-memory). The user's working-tree edits are preserved. The user re-runs `dome submit`; adoption restarts from scratch with the same Proposal.

- **`dome.intake.extract-capture` (garden-phase) emits a 12-PatchEffect chain.** The engine constructs each into a sub-Proposal (per [[wiki/specs/proposals]] §"Garden-emitted Proposals") and adopts them sequentially. If the 7th sub-Proposal blocks, the first 6 already adopted; the 7th's blocking diagnostic surfaces in `dome doctor --show diagnostics`. The user resolves and the engine resumes from the failed sub-Proposal. This isn't "partial write" — each sub-Proposal is its own atomic adoption boundary; the failure is observable and recoverable.

- **Invariant violation discovered mid-loop.** The 4th iteration's patches would violate a capability scope (per [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]]). The broker rewrites the patch to `mode: "propose"` (downgrade) or denies it (depending on grant); the loop continues with the downgraded patch set. Adoption may still reach fixed point; capability-downgrade-surprise diagnostics surface for the user to review.

**Operational notes:**

- The vault is git-backed: `git revert <closure-commit>` is the universal undo for a bad adoption. The Dome-* trailers on the closure commit name the responsible run.
- Long-running garden flows that produce many sub-Proposals (e.g., a backfill processor migrating 50 pages) decompose into independent sub-Proposals automatically. There is no `commit_batch` API; each sub-Proposal is its own adoption boundary.
- `dome doctor --orphan-engine-commits` lists engine commits unreachable from the adopted ref or any branch tip. These are typically GC'd by `git gc` automatically; manual cleanup via `git update-ref -d` on the named ref or `git gc --prune=now`.

**Related:**
- [[wiki/specs/adoption]] §"The fixed-point adoption loop"
- [[wiki/specs/proposals]] §"Garden-emitted Proposals"
- [[wiki/invariants/EVERY_EFFECT_IS_LEDGERED]]
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]]
- [[wiki/gotchas/concurrent-harness-write]] (sister failure mode)
- [[wiki/gotchas/processor-fixed-point-divergence]]
