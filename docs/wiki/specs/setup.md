---
title: Setup assessment and plan
description: Versioned, read-only contracts for assessing a vault and previewing additive setup work.
category: specs
updated: 2026-07-18
---

# Setup assessment and plan

`dome setup` is the planned public onboarding grammar. Before it is allowed to
change a vault or the host, it produces one read-only `VaultAssessment` and one
`SetupPlan`. This page defines those two payloads. It does not define an
installer workflow, a persisted setup record, or a setup state machine.

The pure TypeScript contract lives in `src/setup/contracts.ts`. It is
deliberately not exported from the SDK root: setup is a product boundary, not a
fifth core concept.

## Assessment contract

`dome.setup.vault-assessment/v1` is a recomputed observation of a selected
vault path. It contains:

- the selected path and exactly one closed vault classification;
- a Git `HEAD` when the target is a Git worktree and a deterministic worktree
  fingerprint in all cases;
- host, installed-package, packaged-product, prerequisite, Git, Dome, and
  installed-Home classifications. Packaged Home identity (artifact ID,
  version, build commit, and manifest hash) is distinct from installed Home
  identity and vault-selector truth;
- sorted tracked and untracked Markdown path inventories plus the proposed
  versioned content scope (the matching policy itself is specified in M4);
- a closed, canonically ordered union of additive adaptation actions; and
- zero or more canonically ordered blockers, each with exactly one next action.

The vault classification is one of:

| Kind | Meaning |
| --- | --- |
| `new-path` | The target does not exist. |
| `empty-directory` | The target is an existing empty directory. |
| `existing-non-git-vault` | Owner content exists but there is no repository. |
| `existing-git-vault` | A repository exists and Dome is not configured. |
| `existing-dome-vault` | Dome configuration already exists. |
| `incompatible-active-operation` | Git or Home has an operation that setup must not cross. |
| `unsafe-or-ambiguous-state` | Ownership, path, symlink, host, or another safety fact is unresolved. |

The last two classifications are blocked and therefore carry no adaptation
actions. A ready classification carries no blockers. Dirty worktrees, an
active Git operation, an active Home upgrade, conflicting Home ownership,
symlink ambiguity, an unsupported host, and missing prerequisites are modeled
as blockers instead of implicit choices.

Prerequisite evidence distinguishes absence from incompatibility: a missing
tool has no observed version and a `missing-prerequisite` blocker; an observed
but unsupported tool retains its version and has an
`unsupported-prerequisite` blocker.

`AdaptationAction` is intentionally additive and closed:

- `create-vault-directory`
- `initialize-git`
- `ensure-scaffold-directory`
- `write-scaffold-file`
- `set-content-scope`
- `create-baseline-commit`
- `install-home` (`install-or-resume` or `upgrade`, derived from exact installed
  artifact identity)
- `select-home-vault`
- `install-home-service`
- `start-home`

Directory and scaffold-file actions have closed IDs, normalized modes, and
literal `ifMissing` guards. File actions also bind exact byte counts and
SHA-256 values. There is no generic shell-command, arbitrary-write, delete,
move, overwrite, credential, model, network, or external-integration action.
Adding a future action requires a schema version or a backward-compatible
addition to this closed union plus review at the apply boundary.

## Revision binding

The assessment is not durable setup state. The inspector recomputes it from
the selected path immediately before apply. `revision.head` binds Git history;
`revision.worktreeFingerprint` binds every setup-relevant observation that can
change without moving `HEAD`, including tracked and untracked inventory,
content bytes and modes within the assessment budget, ignore behavior,
symlink evidence, Dome configuration, and the Home vault selector and active
operation evidence.

The read-only inspector lives in `src/setup/vault-inspector.ts`. It selects a
repository only when `.git` exists at the requested root; an ancestor
repository is conflict evidence and is never silently adopted as the vault
boundary. Direct Git directories and linked-worktree gitfiles are supported.
Redirected `.git` symlinks, nested repositories, special files, hard links,
detached or unborn history, active operations, and dirty worktrees fail
closed with a specific blocker.

The inspector validates every selected-path component and walks in byte-stable
sorted order without following symlinks. This applies equally to an existing
vault and to a missing leaf beneath an existing parent; an ancestor symlink is
always ambiguity evidence, never an invitation to inspect its target.
It hashes bounded tracked and untracked regular-file bytes and modes, exact
symlink targets, Git index/HEAD and derived dirty evidence, ignore results,
direct `info/exclude` bytes, the linked-worktree gitfile, Dome configuration, and
injected package or Home selector evidence. It excludes Git internals and
`.dome/state`; ignored content bytes are deliberately not read, while their
paths and ignore behavior remain bound. Entry, file, total-content, command,
and command-time budgets fail closed rather than silently truncating evidence.
Caller-provided cap overrides may only lower production limits, and injected
package/Home evidence has its own bounded inventory.
Equal relevant observations produce the same lowercase SHA-256 value, and a
relevant change produces a different one.

Bun 1.2 does not expose `openat`/`fdopendir`, and macOS does not permit
enumerating an opened directory through `/dev/fd`. A controlled `find -P`
inventory was considered, but it still requires pathname reinspection, cannot
prune the already-derived ignored-directory inventory without an unbounded
argument vector, and introduces platform-specific process behavior without
closing the remaining race. The inspector therefore uses the smaller native
fallback: directories are held open with `O_DIRECTORY | O_NOFOLLOW`, regular
files use `O_NOFOLLOW`, and every file, link, and directory has exact pre/post
device/inode/mode/size/mtime/ctime/link-count proofs. The complete order is
`Target1 → Git1 → Tree1 → Git2 → Tree2 → Git3 → Target2`: all three Git proofs,
both bounded sorted trees, and both target/component proofs must be identical.
A nested directory becoming a symlink is blocked and never traversed in the
second scan. This is fail-closed
for normal cooperative concurrency. It does not claim a kernel-enforced
snapshot against a malicious process racing individual syscalls; apply must
still repeat revision validation immediately before mutation.

Package, prerequisite, and installed-Home discovery remain separate injected
adapters. Git subprocesses use only `rev-parse`, `symbolic-ref`, `ls-files`,
and `ls-tree` under a minimal allowlisted environment with system/global
configuration, prompts, optional locks, hooks, filesystem monitors, pagers,
external excludes, and external attributes disabled. Staged and worktree
dirtiness are derived from index/HEAD plumbing plus Dome's own `O_NOFOLLOW`
byte and mode proofs; setup never invokes `status`, diff drivers, textconv, or
clean/smudge filters. `GIT_NO_LAZY_FETCH=1` and a deny-all transport policy
make a missing partial-clone/promisor object an ambiguity blocker rather than a
fetch; no upload-pack, credential helper, or network transport is attempted.
The fixed command inventory cannot invoke a credential or
network operation. The vault inspector does not read
credentials, call a model, access the network, open the Dome runtime, or
modify Git, files, services, or durable state. Apply compares both revision
bindings and refuses a stale plan. It then
returns a freshly assessed plan; it never applies actions inferred from the
stale value.

Git evidence represents detached and unborn repositories without inventing a
branch or commit: detached means a commit and no branch; unborn means a branch
and no commit. Both are unsafe setup classifications with a specific blocker
and next action. A normal Git worktree carries both; a non-Git target carries
neither.

## Plan contract

`dome.setup.plan/v1` is the single payload consumed by both JSON and human
renderers. It embeds the complete validated assessment, then inventories:

- proposed additive file writes, including operation, exact byte count, and
  SHA-256 of the proposed bytes;
- attributable commits and their exact path sets;
- closed Home service actions;
- optional model and integration setup steps;
- recovery commands; and
- structured warnings.

Path inventories and unordered evidence are canonically sorted and
duplicate-free. Commits and Home service actions follow their explicit
operation order. Contract arrays have fixed budgets. A blocked plan has status
`blocked` and cannot carry applicable writes, commits, or service actions. A
ready plan has status `ready` and no assessment blockers. Unknown fields,
unknown discriminants, unsafe paths, inconsistent Git/HEAD evidence, and
non-canonical arrays fail validation.

The validator cross-checks exact scaffold writes, the baseline commit, and
Home service actions against their assessment actions. Content scope owns the
one exact `vault-config` write: its path, create-or-merge operation, bytes,
hash, mode, and missing-file behavior are bound in the assessment and must be
identical in the plan. `ContentScopeConfig.version` is the literal `1`, so a
future matching-language change cannot silently reinterpret an accepted
setup payload. The shape and matching semantics are owned by
[[wiki/specs/content-scope]]; setup embeds that canonical contract rather than
defining a second glob language. A plan cannot express a second config write or two
writes to the same path. Whenever writes apply, one configuration commit must
name exactly those paths—never an unrelated owner file.

Home plan evidence projects the assessed artifact ID, selected vault path,
service label, and missing-service guard rather than replacing them with prose.
Install and start must use the same service label. An `owned` installed Home
must select the assessed vault; another selector is foreign ownership and must
be classified and blocked before planning. The install disposition is
`install-or-resume` for no installed artifact or the exact candidate identity,
and `upgrade` for a different owned artifact selecting the same vault.

The four Home preview rows—install/upgrade artifact, select vault, install
service, and start—are one atomic activation intent. M6 consumes them through
one deep Home activation call with rollback and recovery; no caller may apply
an individual row as an independent operation.

The plan is a preview and a revision binding, not an execution log. Apply may
consume a successfully revalidated plan in a later slice, but it must not
mutate this payload or persist it as a workflow record.

## Read-only boundary

Assessment is allowed to inspect bounded local metadata and content needed to
produce the contract. It performs no writes, credential reads, service
changes, model calls, or network calls. Rendering performs no further
discovery. Human output and `--json` therefore describe the same validated
plan rather than independently reconstructing setup policy.

Exact JSON fixtures for all seven vault classifications and adversarial
validator coverage live in `tests/setup/contracts.test.ts`.
