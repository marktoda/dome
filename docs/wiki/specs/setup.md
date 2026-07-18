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
  content scope (the matching policy itself is specified in M4);
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
- `install-home`
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

The fingerprint algorithm and bounded inspector are implementation work for
the next setup slice. Their contract is simple: equal relevant observations
produce the same lowercase SHA-256 value, and any relevant change produces a
different one. Apply compares both bindings and refuses a stale plan. It then
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
identical in the plan. A plan cannot express a second config write or two
writes to the same path. Whenever writes apply, one configuration commit must
name exactly those paths—never an unrelated owner file.

Home plan evidence projects the assessed artifact ID, selected vault path,
service label, and missing-service guard rather than replacing them with prose.
Install and start must use the same service label.

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
