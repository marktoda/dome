---
type: invariant
created: 2026-05-25
updated: 2026-05-25
sources: ["[[raw/original-architecture]]", "[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
tier: axiom
---

# LOG_IS_APPEND_ONLY

**Tier:** Axiom — non-disable-able.

**Statement:** `<vault>/log.md` is mutated only by the `appendLog` Tool, which appends a new entry to the end of the file. No other Tool writes to `log.md`. Entries are never modified or deleted in place.

**Why:** The log is the audit trail. Operations on the vault are reconstructable from the log alone. If entries could be rewritten, agent behavior would lose its history-of-record property and trust falls.

**Structural enforcement:** `appendLog(entry)` is the only Tool whose `effects` array contains `{ kind: 'appended-log' }`. It opens `log.md`, seeks to the end, writes the formatted entry, and closes. `writeDocument` and `moveDocument` explicitly do not accept `log.md` as a target.

**Counter-example:** A "log compaction" plugin decides log.md is too large and rewrites it with summarized entries. Violation. The right design: a separate archival tool that writes a frozen copy to `log-archive/YYYY-MM.md` and starts a fresh log.md — the original is never mutated in place.

**Test guarantee:** `tests/invariants/log-is-append-only.test.ts` — runs a representative ingest workflow, captures post-op log.md byte length, runs more operations, asserts post-op-N log.md starts with pre-op-N content unchanged. Asserts no Tool other than `appendLog` produces an `appended-log` effect.

## Why not just `git log`?

A fair question: per-workflow auto-commit (see [[wiki/specs/hooks]] §"Commit policy") makes each Dome workflow produce one git commit, whose subject equals the corresponding `log.md` entry's `## [date] verb | subject` header. `git log` and `log.md` overlap substantially. Why keep both?

Three jobs `log.md` does that `git log` cannot:

- **Self-describing markdown.** The vault must be usable from the markdown alone. A user reading the vault in Obsidian, grepping with `rg`, browsing on GitHub's web UI, or unpacking a `tar` archive that excluded `.git/` still sees the operation history via `log.md`. `git log` requires the git tooling chain and a `.git/` directory; outside that environment it doesn't exist. This honors [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — the vault is canonical without auxiliary indexes.

- **Catches events that don't produce commits.** Hook failures (`hook-failed`), hook quarantine (`hook-disabled`), and any operation the user disabled `git.auto_commit_workflows: false` for, all flow to `log.md` via `appendLog`. They do not appear in `git log` (no commit fired). Without `log.md`, those events would have nowhere to land that survives the session.

- **Catastrophic recovery surface.** If `.git/` corrupts, becomes stale relative to remotes, or the user accidentally `rm -rf .git/`, the operation history survives in `log.md`. The user can replay or audit Dome's recent activity from the markdown alone, then `git init` fresh against the vault content.

The cost is intentional duplication: two append-only operation logs (one for humans, one for git's content-history tooling). Per-workflow auto-commit keeps them aligned automatically; the user never maintains the alignment by hand. `log.md` is the *narrative* layer; `git log` is the *content-diff* layer. Both are useful; neither is sufficient alone.

**Related:**
- [[wiki/specs/sdk-surface]] §"Tool catalog"
- [[wiki/invariants/EVERY_WRITE_IS_LOGGED]]
- [[wiki/matrices/tool-invariant-enforcement]]
