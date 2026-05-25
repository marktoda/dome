---
type: invariant
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
tier: axiom
---

# VAULT_IS_GIT_REPO

**Tier:** Axiom — non-disable-able. Disabling means Dome doesn't function.

**Statement:** Every Dome vault is a git repository. A `.git/` directory exists at vault root. `dome init` creates one; `dome migrate` requires one (initializes if absent); `openVault(path)` refuses to open a non-git directory.

**Why:** Git is Dome's content-addressed change detector, audit trail, undo mechanism, and (future v1+) sync layer. Specifically:

- **Reconciliation** uses `git diff --name-only <last-reconciled-sha> HEAD` + `git status --porcelain` to detect what changed since the last `dome reconcile`. No separate hash-cache code path is needed.
- **Universal undo** is `git revert <commit>` or `git reset --hard <sha>`. Every multi-page partial-write failure mode collapses to this.
- **Audit trail across machines** comes from `git log` over user-authored commits. Combined with `log.md` (which is committed to git), the user has both human-readable per-operation summaries and full content history.
- **Out-of-band edit handling** is structurally clean — out-of-band edits show up as `git status` modifications and as new commits when the user commits. Reconciliation observes them as `document.written.<category>.<type>` events.
- **Multi-device sync (v1+)** is `git push` / `git pull` against a remote, then `dome reconcile` to fire hooks against the synced changes.

**Structural enforcement:** `openVault(path)` walks up from `path` looking for both `.dome/config.yaml` AND `.git/`. If `.dome/` exists but `.git/` doesn't, opens fails with `kind: 'vault-not-git-repo'` and instructs the user to run `cd <vault> && git init && dome doctor`. `dome init` creates the directory tree, writes `.gitignore`, runs `git init`, and produces the initial commit before returning.

**Counter-example:** A user tries to use Dome over a Dropbox sync folder that isn't a git repo. `openVault` refuses. The fix: `cd ~/Dropbox/my-brain && git init && dome init .` (or `dome migrate .` if there's existing content). Dropbox can sync the git repo; we just need git semantics underneath.

**Test guarantee:** `tests/invariants/vault-is-git-repo.test.ts` — asserts `openVault` on a non-git directory returns `vault-not-git-repo` error. Asserts `dome init` on a clean directory produces a valid git repo with an initial commit. Asserts `dome reconcile` on a vault with a corrupted `.git/` fails with a clear error message.

**Operational notes:**

- The user is encouraged to commit periodically; Dome does not auto-commit. Reconciliation handles both committed and uncommitted state.
- `.git/` is treated as `category: external` by Dome's tools — never modified by Dome, never enumerated.
- The `.gitignore` shipped by `dome init` excludes `.dome/cache/`, `.dome/in-flight/`, and `.dome/state/` from version control. Everything else under the vault — including `.dome/config.yaml`, `.dome/prompts/`, `.dome/hooks/` — is tracked.

**Related:**
- [[wiki/specs/vault-layout]] §"Git repository structure"
- [[wiki/specs/cli]] §"dome init", §"dome reconcile"
- [[wiki/specs/hooks]] §"Durability and reconciliation"
- [[wiki/entities/git]]
- [[wiki/entities/isomorphic-git]] *(library; v0.5 dependency)*
- [[wiki/gotchas/dirty-git-state-at-reconcile]]
