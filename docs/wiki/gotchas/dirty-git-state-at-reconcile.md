---
type: gotcha
description: "Running dome sync mid-merge/rebase or with staged changes makes it process conflict noise or refuse; needs clean-git-state guarding."
created: 2026-05-25
updated: 2026-06-10
sources:
  - "[[cohesive/brainstorms/2026-05-25-dome-vision]]"
coverage: off-matrix
enforced_at: src/cli/commands/sync.ts
enforced_at_status: partial
first_observed: 2026-05-25
severity: medium
---

# Dirty git state at sync

**Note on filename:** This gotcha was created pre-Phase-1+3 when `dome reconcile` was the canonical name; the filename is preserved for stable wiki links, but the canonical command surface is now `dome sync` (per [[wiki/specs/adoption]]). `dome reconcile` is retired in v1.

**Symptom:** `dome sync` runs but the user is in the middle of a `git merge` with conflicts, or `git rebase`, or has staged-but-not-committed changes that look identical to native edits. The sync either does the wrong thing (runs processors against merge conflict noise) or refuses to run cleanly.

**Root cause:** The sync loop uses `git status --porcelain` and `git diff --name-only` to detect changes. These commands have different output in clean working trees vs. merging trees. Specifically:

- During `git merge` with conflicts: files appear as `UU` (unmerged) in `git status`.
- During `git rebase`: `.git/REBASE_HEAD` exists; HEAD is detached.
- With staged-but-uncommitted: `git status` shows `M ` (modified-staged) vs ` M` (modified-unstaged).

These states confuse the "what changed since last sync" calculation. The naive answer is "run processors for every file with any pending change," which spams processor work during a merge.

**Structural mitigation:** **`dome sync` refuses states whose branch/adopted-ref boundary is invalid, and should grow explicit merge/rebase guards.**

```
$ dome sync
error: vault is mid-merge (unmerged paths present)
fix: resolve merge conflicts and commit (git status to see conflicts), then re-run dome sync
```

Shipped checks:

1. Detached HEAD → refuse. The adopted-ref substrate requires a branch name.
2. No commits → refuse. There is no branch head to adopt.

Planned checks:

1. `.git/MERGE_HEAD` exists → mid-merge. Refuse.
2. `.git/REBASE_HEAD` exists or `.git/rebase-merge/` directory → mid-rebase. Refuse.
3. `.git/CHERRY_PICK_HEAD` exists → mid-cherry-pick. Refuse.
4. Otherwise: proceed.

For staged-but-uncommitted changes (legitimate state, not an error):

- The v1 one-shot sync adopts branch `HEAD`; uncommitted working-tree edits remain draft state outside the proposal until the user commits them.
- This is the normal "edit in Obsidian or Claude Code, commit, then run sync" workflow.

**`dome serve` and dirty state:**

`dome serve` automatically runs `dome sync` at startup. If the vault is mid-merge, serve refuses to start:

```
$ dome serve --vault ~/vaults/work
error: vault is mid-merge
hook dispatch and intake processing are paused until the merge resolves
fix: resolve conflicts (git status to see them), commit the merge, then re-run dome serve
```

This is intentional — running processors against an unmerged tree could update wiki pages based on conflict-marker-laden content, corrupting the vault.

**Operational notes:**

- A vault in mid-merge state is a temporary condition. The user resolves and commits, then resumes Dome normally.
- For `git stash` users: stashing creates a clean working tree from Dome's perspective. No special handling needed.
- For users with long-running merges: `dome status` reports working-tree dirty counts today. A richer `dome.git.dirty-state` diagnostic remains planned with the explicit merge/rebase guards.

**Counter-example (the bad case before mitigation):** A user is mid-merge. `dome sync` runs blindly. It sees `wiki/entities/danny.md` is in conflict (contains `<<<<<<< HEAD` markers). Adoption and garden processors read the conflict-marker-laden content as normal markdown and derive bad facts or patches from it. The user notices and reverts, but the noise is in the ledger and projections.

With the mitigation: sync refuses. User resolves conflict, commits, runs sync again. Clean.

**Enforcement points:**

- `src/cli/commands/sync.ts` and `src/cli/commands/serve.ts` refuse detached HEAD via the compiler-host drift boundary.
- `src/engine/core/adopt.ts` also produces an adoption diagnostic for detached HEAD.
- A future `src/git/dirty-state.ts` should centralize merge/rebase/cherry-pick detection and be reused by `sync`, `serve`, and any apply-style CLI command.

If another consumer adopts this guard (e.g., a future `dome migrate --apply`), update this enforcement list to name the caller; the predicate should stay shared.

**Related:**
- [[wiki/invariants/VAULT_IS_GIT_REPO]]
- [[wiki/specs/adoption]] — the fixed-point adoption loop this gotcha is the diagnose-step refusal of
- [[wiki/specs/cli]] §"dome sync" and §"dome lint"
- [[wiki/entities/git]]
- [[wiki/gotchas/adopted-ref-divergence]] — sibling diagnose-step refusal at the same boundary
