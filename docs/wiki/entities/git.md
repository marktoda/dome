---
type: entity
tags:
  - infrastructure
  - version-control
created: 2026-05-25
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-05-25-dome-vision]]"
description: "Version control underpinning Dome's durability: change detection via adopted refs, undo, audit trail, temporal queries, future sync."
---

# Git

The version control system that powers Dome's durability, reconciliation, undo, and (future v1+) sync mechanisms. Every Dome vault is a git repository per [[wiki/invariants/VAULT_IS_GIT_REPO]] (axiom tier).

## What Dome uses git for

- **Change detection.** `dome sync` uses `git diff --name-only refs/dome/adopted/<branch> HEAD` + `git status --porcelain` to determine what's changed since the last successful adoption. The adopted ref (per [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]]) is itself a first-class git artifact — git is doing all of the cursor bookkeeping, not a side-channel `.dome/state/` file.
- **Undo.** Every vault operation that mutates content is recoverable via `git revert <commit>` or `git reset --hard <sha>`. The "multi-page partial write" gotcha collapses to a `git reset` recovery.
- **Audit trail.** `git log` provides a content-history view that complements `log.md`'s operation-history view. The two together: git tracks what content changed and when; log.md tracks what Dome operations happened and what they meant.
- **Temporal queries.** "What did this page look like 6 weeks ago?" is `git show HEAD~50:wiki/entities/danny.md`. The substrate for "what was I thinking 6 weeks ago" queries comes from git history directly.
- **Multi-device sync (v1+).** `git push` / `git pull` against a remote (GitHub, a private gitea instance, Syncthing-synced bare repo, etc.) becomes Dome's sync mechanism. After pull, run `dome sync` to adopt the synced commits, run processors, rebuild projections, and advance the adopted ref.

## Why this works structurally

Git's data model — content-addressed blobs in a Merkle DAG — is essentially what Dome would have built for change detection anyway. Reusing it eliminates a category of code Dome doesn't need to maintain.

Git also has decades of operational maturity: handles weird filesystems, corrupted refs, partial pulls, large files (via Git LFS), submodules, etc. Dome inherits all of that for free.

## What Dome does NOT use git for

- **User-intent commits.** The user commits draft vault changes when they want a snapshot. Dome may create engine closure commits while adopting processor PatchEffects; those commits carry Dome trailers and are separate from user-authored intent commits.
- **Branches.** Dome operates on whatever branch the user has checked out. Branching for experimental thinking ("try a research direction; revert if it doesn't pan out") is a user pattern, not a Dome mechanism.
- **Git hooks.** Dome does not rely on `.git/hooks/` for engine behavior. The v1 trigger model is processor-based and lives inside the Dome runtime.

## Implementation

The Dome SDK uses [[wiki/entities/isomorphic-git]] — a pure-JavaScript implementation of the git protocol that reads/writes the same `.git/` format as the git CLI. This means:

- The user does NOT need git installed. The SDK speaks the protocol natively in Bun.
- Existing git repos created by the CLI work without modification.
- A user can `git pull` from the command line one moment and have `dome serve` or `dome sync` see the committed changes the next.

## Recommended user behavior

- **Commit periodically.** Mark snapshots when your work makes sense. The interval is your call; Dome works either way.
- **Use a remote.** Even a bare local-disk remote (`git init --bare` on an external drive) gives backup. v1+ multi-device sync will use remotes.
- **Don't `git push -f`** to a remote you share with another Dome instance. Force-push will confuse reconciliation on the other device.

## See also

- [[wiki/invariants/VAULT_IS_GIT_REPO]] — the axiom
- [[wiki/entities/isomorphic-git]] — the implementation
- [[wiki/gotchas/dirty-git-state-at-reconcile]] — handling mid-merge/rebase
- [[wiki/gotchas/multi-page-partial-write]] — git rollback as the recovery
