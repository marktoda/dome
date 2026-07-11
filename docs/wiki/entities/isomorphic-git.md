---
type: entity
aliases:
  - isomorphic-git
tags:
  - library
  - dependency
created: 2026-05-25
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-05-25-dome-vision]]"
  - "[[wiki/sources/isomorphic-git-library]]"
description: Pure-JS Adapter behind Dome's Git seam for ordinary repositories; linked worktrees use native Git because their gitdir state is split.
---

# isomorphic-git

Pure-JavaScript implementation of git that reads and writes the same `.git/`
format as the git CLI. It is Dome's Adapter for ordinary repositories behind
the single `src/git.ts` seam.

Gitfile repositories are the deliberate exception. Linked worktrees' `.git`
file points to a
per-worktree gitdir whose `commondir` holds common refs and objects;
isomorphic-git cannot represent that split with one `gitdir`. Dome therefore
routes the complete existing Git Interface through native Git whenever it
discovers a valid `.git` file (linked or otherwise). See
[[wiki/gotchas/linked-worktree-gitdir-split]].

## Why this over alternatives

- **`simple-git`** wraps the system git CLI. Requires git installed. Less portable.
- **`nodegit`** uses native C++ bindings. Native deps don't fit Bun's distribution model cleanly.
- **`isomorphic-git`** is pure JS. Zero binary dependency. Works on Bun, Node, browser, and (someday) embedded mobile contexts.

Trade-off: ordinary repositories retain the portability of the pure-JS
Adapter. Linked worktrees already require native Git to create and manage
their split state, so Dome uses that installed binary consistently for the
whole Interface rather than offering a partial fallback.

## What Dome uses

The SDK uses a small subset of the library's surface:

- `git.statusMatrix({ fs, dir, gitdir })` — returns the [filepath, HEAD, workdir, stage] state of every tracked file. Used by status/analytics and change inspection.
- `git.init({ fs, dir })` — invoked by `dome init` to create a fresh git repo.
- `git.commit({ fs, dir, message, author })` — used by `dome init` for the initial commit.
- `git.log({ fs, dir, depth })` — for commit-history views and future temporal queries.
- `git.resolveRef({ fs, dir, ref: 'HEAD' })` — to read branch heads, adopted refs, and current commits.

The `fs` argument is a Bun-compatible filesystem interface; we pass Bun's built-in `fs` module.

## Version pinning

Dome pins to `isomorphic-git ^1.x`. Major version bumps are reviewed for breaking changes; this is a small enough API surface that upgrades are low-risk.

## See also

- [[wiki/entities/git]] — what we use it for
- [[wiki/invariants/VAULT_IS_GIT_REPO]] — the axiom this implements
- [[wiki/gotchas/linked-worktree-gitdir-split]] — why linked layouts use a different Adapter
- [[wiki/sources/isomorphic-git-library]] — the library's own docs and project page
- [[wiki/specs/sdk-surface]] §"Runtime" — the dependency list
