---
title: Setup assessment and plan
description: Versioned, read-only contracts for assessing a vault and previewing additive setup work.
category: specs
updated: 2026-07-18
---

# Setup assessment and plan

`dome setup --dry-run` is the first public onboarding grammar. Before a later
slice is allowed to change a vault or the host, this command produces one
read-only `VaultAssessment` and one `SetupPlan`. This page defines those two
payloads. It does not define an installer workflow, a persisted setup record,
or a setup state machine.

The pure TypeScript contract lives in `src/setup/contracts.ts`. It is
deliberately not exported from the SDK root: setup is a product boundary, not a
fifth core concept.

## Assessment contract

`dome.setup.vault-assessment/v1` is a recomputed observation of a selected
vault path. It contains:

- the selected path, its observed state (`missing`, `empty-directory`, or
  `existing`), and exactly one closed vault classification;
- a Git `HEAD` when the target is a Git worktree and a deterministic worktree
  fingerprint in all cases;
- host, installed-package, packaged-product, prerequisite, Git, Dome, and
  installed-Home classifications. Packaged Home identity (artifact ID,
  version, build commit, and manifest hash) is distinct from installed Home
  identity and vault-selector truth;
- sorted tracked and untracked lowercase-`.md` path inventories plus the
  proposed versioned content scope. Case-variant `.MD` files remain ordinary
  source bytes for revision binding but are outside version 1's owner-Markdown
  universe; `.dome/**` and `.git/**` remain the non-overridable private floor;
- one bounded, content-free repository inventory. Every row reports only its
  relative path, kind, byte count, Git tracking classification, proposed
  baseline disposition, and one closed safety reason. `baselineTracked` is the
  exact sorted set of direct bounded owner files proposed for a future non-Git
  owner baseline; an existing Git repository never gets a second baseline;
- the observed Dome content-scope state: `absent`, `configured`, or
  `incompatible`; and
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

The last two classifications are blocked. A ready classification carries no
blockers. Dirty worktrees, an
active Git operation, an active Home upgrade, conflicting Home ownership,
symlink ambiguity, an unsupported host, and missing prerequisites are modeled
as blockers instead of implicit choices.

`src/setup/classification.ts` owns the one deterministic evidence-to-kind
mapping used by the inspector, compiler, and public validators. Configuration
evidence produces `existing-dome-vault` only at a direct Git boundary;
configured non-Git content remains `existing-non-git-vault` until setup creates
its repository. A Git or Home active operation alone produces
`incompatible-active-operation`; other blockers produce
`unsafe-or-ambiguous-state`; the remaining ready kinds follow direct Git and
observed target state. A supplied kind that disagrees with that evidence is
invalid rather than a caller-controlled label.

Prerequisite evidence distinguishes absence from incompatibility: a missing
tool has no observed version and a `missing-prerequisite` blocker; an observed
but unsupported tool retains its version and has an
`unsupported-prerequisite` blocker.

The assessment contains observations and blockers only. The `SetupPlan` owns
the single closed, canonically ordered `AdaptationAction` inventory:

- `create-vault-directory`
- `initialize-git`
- `ensure-scaffold-directory`
- `write-scaffold-file`
- `set-content-scope`
- `activate-home` (`install-or-resume` or `upgrade`, derived from exact
  installed artifact identity)

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
Any component that case-folds to `.dome` or `.git` without being that exact
lowercase spelling, or to `state` directly beneath `.dome`, is blocked before
it is opened, read, or traversed. This fail-closed rule prevents
case-insensitive filesystem aliases such as `.DOME` or `.dome/STATE` from
bypassing the private floor. Root control-name aliases are preflighted before
Git inspection, so `.Git` cannot cause even a read-only Git command to parse
aliased control metadata.
It hashes bounded tracked and untracked regular-file bytes and modes, exact
symlink targets, Git index/HEAD and derived dirty evidence, ignore results,
direct `info/exclude` bytes, the linked-worktree gitfile, Dome configuration, and
injected package or Home selector evidence. It excludes Git internals and
`.dome/state`; ignored and sensitive-name content bytes are deliberately not
read, while their paths, byte counts, filesystem identity, and safety/ignore
classifications remain bound. Entry, file, total-content, command,
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
adapters. Packaged identity delegates to the read-only closed-package layer of
the installed-product verifier rather than weakening that trust boundary in
setup or invoking its full Home extraction/admission layer. The pure compiler applies a
closed minimum-version policy to observed tools: Bun `>=1.2.13 <2` and Git
`>=2.45.0`. Git 2.45 is the first release carrying the
`GIT_NO_LAZY_FETCH` boundary used below. The final fingerprint composes the
vault-source fingerprint with host, prerequisite, packaged-product,
installed-Home, content-scope, and scaffold evidence, so a relevant injected
evidence change invalidates the plan. Git subprocesses use only `rev-parse`, `symbolic-ref`, `ls-files`,
and `ls-tree` under a minimal allowlisted environment with system/global
configuration, prompts, optional locks, hooks, filesystem monitors, pagers,
external excludes, and external attributes disabled. Staged and worktree
dirtiness are derived from index/HEAD plumbing plus Dome's own `O_NOFOLLOW`
byte and mode proofs; setup never invokes `status`, diff drivers, textconv, or
clean/smudge filters. For a tracked sensitive-name file, the inspector instead
compares content-free index stat evidence from `ls-files --debug` with its
repeated `lstat` identity proofs. A match may prove the path clean without
loading its contents into Dome; missing or changed evidence is dirty or
ambiguous, never assumed clean. `GIT_NO_LAZY_FETCH=1` and a deny-all transport
policy make a missing partial-clone/promisor object an ambiguity blocker rather
than a fetch; no upload-pack, credential helper, or network transport is attempted.
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
renderers. It embeds the complete validated assessment and owns one closed,
canonically ordered action inventory. Optional model and integration steps,
recovery commands, and structured warnings remain separate presentation
metadata. There are no duplicated write, commit, or service-action
projections for the validator to keep in sync.

Path inventories and unordered evidence are canonically sorted and
duplicate-free. Actions follow their explicit operation order. Contract arrays
have fixed budgets. A blocked plan has status `blocked` and carries no actions.
A ready plan has status `ready` and no assessment blockers. Unknown fields,
unknown discriminants, unsafe paths, inconsistent Git/HEAD evidence, and
non-canonical arrays fail validation.

Public assessment and plan validators first compile untrusted values into a
bounded passive snapshot. Proxies are rejected before their traps run,
accessor-backed properties are never invoked, and array lengths are checked
against field-specific caps before any element traversal. One aggregate node
budget counts objects, arrays, primitive elements, and holes. Zod sees only
that inert snapshot. Successful values are recursively frozen, so renderers
and a future apply implementation consume one immutable canonical contract.

Write actions bind their exact path, create-or-merge operation, bytes, hash,
mode, and missing-file behavior. `ContentScopeConfig.version` is the literal
`1`, so a future matching-language change cannot silently reinterpret an
accepted setup payload. The shape and matching semantics are owned by
[[wiki/specs/content-scope]]; setup embeds that canonical contract rather than
defining a second glob language. Both the in-memory proposal and the
`content_scope` decoded from the exact rendered YAML pass through
`canonicalContentScopeSchema`; unsorted, duplicate, unsupported, or malformed
policies fail closed. The same runtime capability-policy parser validates the
entire generated fresh config—not only its `content_scope` subtree—and the
managed migration fragment must itself be standalone valid runtime config.
Both parsed policies must carry the exact proposed scope. Content scope also
participates in the capability-policy hash. A fresh vault gets one complete
create-file config action. An existing Dome vault with no scope gets one
explicit `merge-managed-config` action carrying the exact managed fragment
plus a `content-scope-migration` warning; setup never treats that migration as
already accepted. Malformed existing scope blocks as incompatible. A plan
cannot express a second config write or two writes to the same path.

The one atomic `activate-home` action projects the assessed artifact ID,
selected vault path, service label, missing-service guard, and install
disposition rather than replacing them with prose. An `owned` installed Home
must select the assessed vault; another selector is foreign ownership and must
be classified and blocked before planning. The disposition is
`install-or-resume` for no installed artifact or the exact candidate identity,
and `upgrade` for a different owned artifact selecting the same vault. M6 will
consume this action through one deep Home activation call with rollback and
recovery; there are no independently applicable install, select, service, or
start rows.

The action's service label is not caller-selected. Setup and the Home lifecycle
derive it through the neutral `src/core/vault-service-identity.ts` Module, and
the plan validator recomputes the exact label from the assessed vault path.

For an existing non-Git vault, the inspector revision-binds every bounded,
nonsensitive, nonignored regular-file byte and mode—not only Markdown—and blocks
symlinks, nested repositories, special files, and unsafe hard links. M3 does
not yet emit a baseline-commit action. M5 must first define the exact safe Git
inventory, ignore/exclusion behavior, and commit boundary so owner attachments,
configuration, and other non-Markdown files are preserved. Only then may apply
initialize and baseline that repository; the preview must never imply a
Markdown-only baseline.

M5's first read-side checkpoint exposes that exact proposed tracked set in both
assessment presentations. The policy is deliberately conservative: a regular
file enters the proposal only when it is direct, bounded, nonignored, outside
`.dome/state/**`, and its path does not match the closed sensitive-name policy
(`.env*`, credential/secret/token/password/private-key names, private-key
stems, or common key-container suffixes). Directories, ignored paths,
sensitive-name files, large files, and Dome-private paths are
`preserve-untracked`; paths already in an existing Git index are
`already-tracked`. Nested repositories, symlinks (classified lexically as
internal or external without following them), special files, and hard-linked
files are `blocked`. The rows contain no source bytes. The apply checkpoint
must consume this exact inventory under explicit consent; it may not rediscover
a broader tracked set.

For a non-Git owner vault, setup loads a bounded direct `.gitignore` in every
directory it traverses before inspecting that directory's remaining children.
It evaluates the hierarchical rule stack with the mature `ignore` library's
Git-compatible semantics: patterns are relative to the directory containing
their file, rule order and negation are preserved, and a deeper `.gitignore`
takes precedence according to Git's normal matching rules. Setup passively
probes whether each directory resolves `.gitignore` and a case variant to the
same inode, then configures `ignore` with the same case behavior Git will infer
when it initializes the repository; a distinct case-variant collision blocks.
An ignored directory is pruned before any descendant is `lstat`ed, read, or
hashed; the pruned subtree consumes neither the content nor entry budget.
Other ignored entries are classified without reading their content bytes. All
bounded policy bytes and resulting classifications remain revision-bound.
Setup does not maintain a second partial ignore-language implementation.
Structural unsafety dominates ignore status: ignored symlinks and special files
retain their structural reason, and an ignored hard link is still blocked.

A later apply implementation must first recompute and validate the complete
assessment and then stage exactly `baselineTracked`. Every
`preserve-untracked` row must still exist with the revalidated disposition and
must remain uncommitted after the baseline. Apply must never use a broad add,
stage an ignored or sensitive candidate, or reinterpret a preserved row merely
because Git initialization or scaffold creation changed the worktree.

The plan is a preview and a revision binding, not an execution log. Apply may
consume a successfully revalidated plan in a later slice, but it must not
mutate this payload or persist it as a workflow record.

## Read-only boundary

Assessment is allowed to inspect bounded local metadata and content needed to
produce the contract. It performs no writes, credential reads, service
changes, model calls, or network calls. The read-only installed-product proof
hashes the closed tree and compressed Home archive without extracting or
executing it; full Home admission remains a later apply concern. Rendering performs no further
discovery. Human output and `--json` therefore describe the same validated
plan rather than independently reconstructing setup policy.

The implemented root command requires `--dry-run`; it has no `--apply` flag.
A ready preview exits zero, a valid blocked preview exits one, and a usage
error exits 64. Both presentations explicitly state that no changes were made.

Exact JSON fixtures for all seven vault classifications and adversarial
validator coverage live in `tests/setup/contracts.test.ts` and
`tests/setup/compiler.test.ts`. CLI adapter coverage proves that omission of
`--dry-run` cannot invoke discovery and JSON is the exact validated plan. The
case-sensitive inventory fixture and generated-config round trip pin setup to
the same versioned ContentScope interface used by the setup contract.
