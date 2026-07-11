---
type: source
created: 2026-05-25
updated: 2026-07-11
sources: []
author: William Hilton et al.
description: "Project page for the pure-JS git library Dome depends on; takeaway: standard .git format, no binary needed, fast enough for Dome's use."
external: true
url: https://isomorphic-git.org/
---

# isomorphic-git library (source page)

Pure-JS git implementation. Project page at https://isomorphic-git.org/.

## Why this exists in the wiki

The Dome SDK depends on isomorphic-git for git operations (per [[wiki/invariants/VAULT_IS_GIT_REPO]] and [[wiki/entities/isomorphic-git]]). This source page is the canonical reference to the library itself — its docs, version, license — separate from how Dome uses it (covered in the entity page).

## Key claims about the library

- Pure JavaScript implementation of git. No native code. No shelling out to a git binary.
- Reads and writes the standard `.git/` format. Repos created by isomorphic-git are interoperable with the git CLI, GitHub, etc.
- Works in browser, Node, Bun. Same code path everywhere.
- MIT licensed.
- ~6 years of active maintenance as of 2026. Stable API.

## What Dome takes from it

- A `statusMatrix` primitive that returns per-file workdir/HEAD/stage state. Used as the reconciliation primitive.
- An `init` + `commit` flow for `dome init`.
- Standard git operations for v1+ sync (push/pull/clone).

## Limitations Dome accepts

- Slower than the native git CLI for large operations. Acceptable for Dome's small-to-medium reconciliation workloads.
- Linked-worktree `commondir` layouts are not represented by a single
  isomorphic-git `gitdir`. Dome handles this relevant exception with a
  complete native-git Adapter behind the same `src/git.ts` seam.

## See also

- [[wiki/entities/isomorphic-git]] — Dome's usage and reasoning
- [[wiki/entities/git]] — what we use git for
- [[wiki/invariants/VAULT_IS_GIT_REPO]] — the axiom
