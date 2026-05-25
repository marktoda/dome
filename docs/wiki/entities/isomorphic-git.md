---
type: entity
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]", "[[wiki/sources/isomorphic-git-library]]"]
aliases: ["isomorphic-git"]
tags: ["library", "dependency"]
---

# isomorphic-git

Pure-JavaScript implementation of git that reads and writes the same `.git/` format as the git CLI. Dome v0.5's mechanism for talking to git from Bun without requiring the git binary to be installed.

## Why this over alternatives

- **`simple-git`** wraps the system git CLI. Requires git installed. Less portable.
- **`nodegit`** uses native C++ bindings. Native deps don't fit Bun's distribution model cleanly.
- **`isomorphic-git`** is pure JS. Zero binary dependency. Works on Bun, Node, browser, and (someday) embedded mobile contexts.

Trade-off: isomorphic-git is slower than the native git CLI for some operations (deep object walks, big repos). For Dome's use cases — `git status --porcelain`, `git diff --name-only <sha> HEAD`, occasional `git log` — the difference is milliseconds. Worth the portability.

## What Dome uses

The SDK uses a small subset of the library's surface:

- `git.statusMatrix({ fs, dir, gitdir })` — returns the [filepath, HEAD, workdir, stage] state of every tracked file. The primary reconciliation primitive.
- `git.init({ fs, dir })` — invoked by `dome init` to create a fresh git repo.
- `git.commit({ fs, dir, message, author })` — used by `dome init` for the initial commit.
- `git.log({ fs, dir, depth })` — for temporal queries (future feature; not in v0.5 hot path).
- `git.resolveRef({ fs, dir, ref: 'HEAD' })` — to read the current HEAD SHA for the reconciliation pointer.

The `fs` argument is a Bun-compatible filesystem interface; we pass Bun's built-in `fs` module.

## Version pinning

v0.5 pins to `isomorphic-git ^1.x` (latest stable at time of writing). Major version bumps are reviewed for breaking changes; this is a small enough API surface that upgrades are low-risk.

## See also

- [[wiki/entities/git]] — what we use it for
- [[wiki/invariants/VAULT_IS_GIT_REPO]] — the axiom this implements
- [[wiki/sources/isomorphic-git-library]] — the library's own docs and project page
- [[wiki/specs/sdk-surface]] §"Runtime" — the dependency list
