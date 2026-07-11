---
type: gotcha
created: 2026-07-11
updated: 2026-07-11
description: Linked Git worktrees split per-worktree HEAD/index state from common refs/objects; one isomorphic-git gitdir cannot represent both.
---

# Linked worktree gitdir split

A linked worktree has a `.git` **file**, not a `.git` directory. That file
points at a per-worktree gitdir containing `HEAD` and `index`; its `commondir`
points back to the primary repository for refs and objects. Treating either
directory as the whole repository silently reads or writes the wrong branch
or index.

`src/git.ts` is the sole Git seam. It parses and validates `.git` files
(including relative `gitdir:` targets), discovers the repository layout once
per operation, and routes the complete existing Interface through one Adapter:

- ordinary `.git/` repositories use isomorphic-git (with the few existing
  native plumbing operations still hidden inside the same Module);
- valid `.git`-file repositories use native Git for **all** reads and writes;
  a `commondir` identifies the linked-worktree form, while other valid
  gitfiles (for example a separate gitdir) use the same complete Adapter.

Do not add a read-only fallback or delegate an individual linked-worktree
operation back to isomorphic-git. Reads and writes must share the same view of
HEAD, the index, refs, and objects. The acceptance fixture creates a real
`git worktree add`, performs capture through engine adoption on the linked
branch, and proves the primary branch and both indexes remain isolated.

The Adapter also preserves the safety semantics callers rely on: checkout
dry-runs reject overwrites and deletions before touching bytes, pathspecs are
literal and contained within the vault, inherited Git-directory environment
overrides are stripped, symlinks are hashed as link targets, and an unmerged
index is rejected instead of flattened into misleading status codes. Signed
commit logs are rejected explicitly until their signing-payload shape is
implemented; they never silently masquerade as the ordinary log Interface.

## See also

- [[wiki/entities/git]]
- [[wiki/entities/isomorphic-git]]
- [[cohesive/plans/2026-07-11-productization-modernization]]
