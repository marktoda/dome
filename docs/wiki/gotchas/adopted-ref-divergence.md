---
type: gotcha
created: 2026-05-27
updated: 2026-05-29
sources: ["[[cohesive/delta-ledgers/2026-05-27-phase-1-3-adopted-ref-and-patch-trailers]]"]
severity: medium
coverage: off-matrix
enforced_at: src/adopted-ref.ts
---

# adopted-ref-divergence

**Symptom:** After a force-push, hard-reset, or rebase that rewrites the current branch's history, `refs/dome/adopted/<branch>` points at a commit no longer in HEAD's ancestry. `dome sync` refuses to advance with the error "adopted ref is not an ancestor of HEAD"; `dome status` surfaces the divergence with `sync diverged` and `adopted_diverged: true` in JSON.

**Severity:** Medium. The vault is not corrupted — every markdown file is still readable, every git commit is still in place, every wikilink still resolves — but Dome's "what is the latest trusted state" cursor is now unreliable for queries until the user resolves the divergence. Until resolution, `dome status` reports divergence, `dome sync` refuses before constructing a Proposal, `dome serve` pauses adoption, and downstream tooling that queries the adopted ref sees stale data.

**When you'll hit this:**

- The user (or their git collaborator) force-pushed to the source branch (`git push --force` to overwrite remote history; the user then `git pull --force` or `git reset --hard origin/main` to mirror locally).
- The user hard-reset HEAD to an earlier commit (`git reset --hard HEAD~5`) and then committed a different change on top, producing a branch whose ancestry no longer contains the prior adopted commit.
- The user rebased the current branch onto a different base (`git rebase --onto`), rewriting every commit's SHA and so removing the prior adopted commit from the new branch ancestry.
- A vault was synced across machines via mechanisms other than `git push/pull` (rsync, Dropbox, etc. — not Dome's intended sync model), and the two machines have divergent histories one of which carries an adopted ref the other doesn't recognize.

**Recovery:**

1. **Inspect the divergence.**
   ```bash
   cd ~/vaults/work
   dome status                              # surfaces the divergence
   git log --oneline <adopted-sha>..HEAD    # what does HEAD have that adopted doesn't?
   git log --oneline HEAD..<adopted-sha>    # what does adopted have that HEAD doesn't?
   ```
   The two-way diff shows the rewritten work. If the new HEAD is the intended trunk (the common case after a `git reset --hard origin/main` or `git pull --rebase`), proceed to step 2. If the rewrite was unintentional, proceed to step 3.

2. **Accept the new HEAD as the adopted ref's new target.**
   ```bash
   cd ~/vaults/work && dome sync --force-advance
   ```
   This is the intended v1.1 recovery flow. The underlying engine/adopted-ref boundary already has a `forceAdvance` option, but the user-facing `dome sync --force-advance` flag is not shipped in v1.0. Until it lands, resolve manually by restoring the intended branch history or updating the adopted ref only after confirming the new HEAD is the intended trunk.

3. **Restore the prior HEAD via `git reflog`.**
   ```bash
   cd ~/vaults/work
   git reflog                               # find the prior HEAD's reflog entry
   git reset --hard HEAD@{N}                # restore (N = the reflog entry index)
   dome sync                                # now in fast-forward mode again
   ```
   This recovers from an unintentional rewrite. The adopted ref is once again an ancestor of HEAD, and the divergence diagnostic clears.

**Why the structural fence:** Without the fast-forward check, a force-push could silently move adopted to a commit that no longer carries the engine-closure work the prior adopted commit had. Future `dome sync` runs would re-do work that was already done. Idempotency saves deterministic processors in practice, but the diagnostic saves the user from confusion and from running expensive model-backed processors redundantly. The structural fence exists twice: `detectDrift` refuses divergent histories before adoption/branch materialization can start, and `setAdoptedRef` keeps the write side fast-forward-only. The internal `forceAdvance: true` opt-out is explicit and named.

**Why NOT silently force-advance:** A silent force-advance is wrong for the unintentional-rewrite case — the user wanted to keep their prior history, the force-advance would lose it. The opt-in flag makes the user assert "I know the rewrite was intentional; advance anyway." The default-refuse posture is safer.

**Related:**

- [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]] — pins the ref's existence and the fast-forward semantics.
- [[wiki/gotchas/dirty-git-state-at-reconcile]] — the sibling "git state is wrong, refuse" gotcha.
- [[wiki/specs/adoption]] — §"The adopted ref" names the divergence case explicitly.
