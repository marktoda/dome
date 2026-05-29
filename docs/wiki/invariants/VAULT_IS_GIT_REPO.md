---
type: invariant
created: 2026-05-25T00:00:00.000Z
updated: 2026-05-29T00:00:00.000Z
sources:
  - '[[cohesive/brainstorms/2026-05-25-dome-vision]]'
tier: axiom
---

# VAULT_IS_GIT_REPO

**Tier:** Axiom — non-disable-able. Disabling means Dome doesn't function.

**Statement:** Every Dome vault is a git repository. A `.git/` directory exists at vault root. `dome init` creates one; `dome migrate` requires one (initializes if absent); `openVault(path)` refuses to open a non-git directory.

**Why:** Git is Dome's content-addressed change detector, audit trail, undo mechanism, and (v1.5+) hosted-protected sync layer. Specifically:

- **Adoption** uses `git diff --name-only refs/dome/adopted/<branch> HEAD` + `git status --porcelain` to compute the changed-paths set for each Proposal (per [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]] — the adopted ref is the canonical cursor; per [[wiki/specs/adoption]] §"Compile range" — the engine's `compileRange` primitive consumes this). No separate hash-cache code path is needed.
- **Universal undo** is `git revert <closure-commit>` or `git reset --hard <sha>`. The Dome-* trailers on engine commits per [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]] name the responsible run, making targeted reverts identifiable.
- **Audit trail across machines** comes from `git log --grep="^Dome-Run:"` (engine commits) combined with the run ledger SQLite (richer per-run audit). Per [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]] the two surfaces are dual provenance.
- **Native write handling** is structurally clean — native writes show up as `git status` modifications and (when the user commits) as new commits. The watcher constructs Proposals from these per [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]].
- **Multi-device sync (v1.5+)** is `git push` / `git pull` against a remote (in local mode) or hosted-protected PR flow (per [[wiki/specs/adoption]] §"Hosted-protected mode"); the same adoption loop runs against the synced changes.

**Structural enforcement:** `openVault(path)` walks up from `path` looking for both `<vault>/.dome/config.yaml` AND `<vault>/.git/`. If `.dome/` exists but `.git/` doesn't, open fails with `kind: 'vault-not-git-repo'` and instructs the user to run `cd <vault> && git init && dome sync`. `dome init` creates the directory tree, writes `.gitignore`, runs `git init`, and produces the initial commit (which the engine then adopts to initialize the adopted ref) before returning.

**Counter-example:** A user tries to use Dome over a Dropbox sync folder that isn't a git repo. `openVault` refuses. The fix: `cd ~/Dropbox/my-brain && git init && dome init .` (or `dome migrate .` if there's existing content). Dropbox can sync the git repo; we just need git semantics underneath.

**Test guarantee:** `tests/invariants/vault-is-git-repo.test.ts` — asserts `openVault` on a non-git directory returns `vault-not-git-repo` error. Asserts `dome init` on a clean directory produces a valid git repo with an initial commit and an initialized adopted ref. Asserts `dome sync` on a vault with a corrupted `.git/` fails with a clear error message.

**Operational notes:**

- Engine commits land atomically per Proposal as closure commits with the four Dome-* trailers per [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]]. User native edits remain draft until the user commits them; `dome sync` / `dome serve` then construct internal Proposals from committed branch state and adopt them.
- `.git/` is treated as `category: external` by the engine — never modified by Dome, never enumerated as part of vault content.
- The `.gitignore` shipped by `dome init` excludes `<vault>/.dome/state/`
  from version control. `projection.db` knowledge rows are derived per
  [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]; answers, the run ledger,
  outbox, and quarantine state are durable operational state that remains
  gitignored but is not fully rebuildable. Everything else under the vault —
  including `<vault>/.dome/config.yaml`, `<vault>/.dome/page-types.yaml`, and
  `<vault>/.dome/extensions/` — is tracked.

**Related:**
- [[wiki/specs/vault-layout]] §"Git repository structure"
- [[wiki/specs/cli]] §"dome init", §"dome sync"
- [[wiki/specs/adoption]] — the fixed-point loop that consumes Proposals constructed from git state
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]] — engine commits and their provenance trailers
- [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]] — native writes flow through adoption via the watcher
- [[wiki/entities/git]]
- [[wiki/entities/isomorphic-git]] *(library; v1 dependency)*
- [[wiki/gotchas/dirty-git-state-at-reconcile]]
