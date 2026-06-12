---
type: source
description: "Project page for the pure-JS git library Dome depends on; takeaway: standard .git format, no binary needed, fast enough for Dome's use."
created: 2026-05-25
updated: 2026-05-25
sources: []
url: "https://isomorphic-git.org/"
author: "William Hilton et al."
external: true
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
- A few esoteric git features aren't implemented (submodules, sparse-checkout extensions). None are relevant to Dome.

## See also

- [[wiki/entities/isomorphic-git]] — Dome's usage and reasoning
- [[wiki/entities/git]] — what we use git for
- [[wiki/invariants/VAULT_IS_GIT_REPO]] — the axiom
