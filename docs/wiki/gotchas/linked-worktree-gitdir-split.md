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

`src/git.ts` is the sole Git seam. It discovers the repository layout once per
operation and routes the complete existing Interface through one Adapter:

- ordinary `.git/` repositories use isomorphic-git (with the few existing
  native plumbing operations still hidden inside the same Module);
- linked `.git`-file worktrees use native Git for **all** reads and writes.

Do not add a read-only fallback or delegate an individual linked-worktree
operation back to isomorphic-git. Reads and writes must share the same view of
HEAD, the index, refs, and objects. The acceptance fixture creates a real
`git worktree add`, makes a tree-only capture commit on the linked branch, and
proves the primary branch and both indexes remain isolated.

## See also

- [[wiki/entities/git]]
- [[wiki/entities/isomorphic-git]]
- [[cohesive/plans/2026-07-11-productization-modernization]]
