---
type: gotcha
created: 2026-05-25
updated: 2026-05-25
severity: medium
coverage: off-matrix
first_observed: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# Dirty git state at reconcile

**Symptom:** `dome reconcile` runs but the user is in the middle of a `git merge` with conflicts, or `git rebase`, or has staged-but-not-committed changes that look identical to out-of-band edits. Reconciliation either does the wrong thing (re-fires hooks for changes that are actually merge conflict noise) or refuses to run cleanly.

**Root cause:** Reconciliation uses `git status --porcelain` and `git diff --name-only` to detect changes. These commands have different output in clean working trees vs. merging trees. Specifically:

- During `git merge` with conflicts: files appear as `UU` (unmerged) in `git status`.
- During `git rebase`: `.git/REBASE_HEAD` exists; HEAD is detached.
- With staged-but-uncommitted: `git status` shows `M ` (modified-staged) vs ` M` (modified-unstaged).

These states confuse the "what changed since last reconcile" calculation. The naive answer is "re-fire hooks for every file with any pending change," which spams hooks during a merge.

**Structural mitigation:** **`dome reconcile` detects pre-merge/rebase state and refuses with a clear error.**

```
$ dome reconcile
error: vault is mid-merge (unmerged paths present)
fix: resolve merge conflicts and commit (git status to see conflicts), then re-run dome reconcile
```

Detection checks (in order):

1. `.git/MERGE_HEAD` exists → mid-merge. Refuse.
2. `.git/REBASE_HEAD` exists or `.git/rebase-merge/` directory → mid-rebase. Refuse.
3. `.git/CHERRY_PICK_HEAD` exists → mid-cherry-pick. Refuse.
4. Otherwise: proceed.

For staged-but-uncommitted changes (legitimate state, not an error):

- Reconciliation processes them as out-of-band edits — fires `document.written.<category>.<type>` events. The hooks (e.g., `auto-update-index`) run; their effects also land as further uncommitted changes. The user commits when ready.
- This is the normal "edit in Obsidian, then run reconcile" workflow.

**`dome serve` and dirty state:**

`dome serve` automatically runs `dome reconcile` at startup. If the vault is mid-merge, serve refuses to start:

```
$ dome serve --vault ~/vaults/work
error: vault is mid-merge
hook dispatch and intake processing are paused until the merge resolves
fix: resolve conflicts (git status to see them), commit the merge, then re-run dome serve
```

This is intentional — running hooks against an unmerged tree could update wiki pages based on conflict-marker-laden content, corrupting the vault.

**Operational notes:**

- A vault in mid-merge state is a temporary condition. The user resolves and commits, then resumes Dome normally.
- For `git stash` users: stashing creates a clean working tree from Dome's perspective. No special handling needed.
- For users with long-running merges: `dome doctor` reports the dirty state and suggests resolution.

**Counter-example (the bad case before mitigation):** A user is mid-merge. `dome reconcile` runs blindly. It sees `wiki/entities/danny.md` is in conflict (contains `<<<<<<< HEAD` markers). It fires `document.written.wiki.entity`. The `auto-update-index` hook reads the conflict-marker-laden content as the entity description. The index gets garbage. The user notices and reverts — but the noise is in the log.

With the mitigation: reconcile refuses. User resolves conflict, commits, runs reconcile again. Clean.

**Enforcement points** (where `isDirtyGitState` is consulted):

- `src/reconcile.ts` — the original caller; `reconcile()` refuses to run when the predicate returns true.
- `src/cli/commands/lint.ts` — `domeLint`'s apply-mode branch reuses the same predicate before dispatching any mutating workflow, mirroring reconcile's refusal. The predicate is exported from `reconcile.ts` rather than duplicated, so both surfaces agree on what "dirty" means.

If a third consumer adopts this guard (e.g., a future `dome migrate --apply` that's been long-running), promote `isDirtyGitState` to its own module (`src/git-state.ts`) and update this enforcement list.

**Related:**
- [[wiki/invariants/VAULT_IS_GIT_REPO]]
- [[wiki/specs/cli]] §"dome reconcile" and §"dome lint" (apply mode)
- [[wiki/specs/hooks]] §"Durability and reconciliation"
- [[wiki/entities/git]]
