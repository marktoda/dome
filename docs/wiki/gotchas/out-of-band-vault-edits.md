---
type: gotcha
created: 2026-05-25
updated: 2026-05-26
severity: low
coverage: off-matrix
enforced_at: src/watcher.ts
first_observed: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]", "[[cohesive/brainstorms/2026-05-26-dome-compiler-reframe]]"]
---

# Native vault writes (the canonical write path for consumer shells)

**Status note (2026-05-26):** Under the compiler reframe ([[VISION]] §"Two surface patterns"), native filesystem writes from consumer shells are the *canonical* write path — not a tolerated workaround. This document is preserved as a gotcha for two reasons: (a) the edge cases it names remain real; (b) the term "out-of-band" still appears in event names (`vault.out-of-band-edit`) and substrate citations from the pre-reframe era. The framing below treats native writes as the canonical path and names the substrate machinery that makes them work — what was previously called "tolerated" is now what the system is designed around.

**Scenario:** The user edits a wiki page in Obsidian. Or Claude Code's `Write` tool rewrites a page during a conversation. Or vim edits the file directly. Or `git pull` brings in changes from a remote. The page now reflects new content; the index and any derived state hasn't yet caught up.

**Why this is canonical, not a bug:** Markdown is the source of truth (`MARKDOWN_IS_SOURCE_OF_TRUTH`). Consumer shells write to the filesystem directly because that's the most natural path for the surface they live on — Claude Code has `Write`; Obsidian has its built-in editor; vim has `:w`; git has `pull`. Dome's Tools are *one* mutation path (the path Dome's internal workflows and hooks use); the other paths exist and are first-class. The compiler-boundary contract ([[wiki/specs/harnesses]] §"The compiler-boundary contract") is built around the watcher catching native writes and the hook chain reconciling.

**Structural mechanism (the watcher + reconcile loop):**

- **Watcher (primary, real-time when `dome serve` is running).** `VaultWatcher` (chokidar) observes `wiki/`, `inbox/`, `raw/`, and `notes/`. On any filesystem change, it fires `vault.out-of-band-edit` events with the changed path and operation kind. Shipped-default reactive hooks observe these events: `auto-update-index` updates `index.md`; an `appendLog` hook records the change with `source: 'out-of-band'`; other hooks (frontmatter validation, future classifiers) can register against the same event.
- **Reconcile (secondary, fills the daemon-off gap).** `dome reconcile`'s git-diff replay phase fires the same `document.written.<category>.<type>` events for every file changed since `.dome/state/last-reconciled-sha.txt`. Events the watcher missed (daemon was off, OS event coalescing under load) get processed by the same hook chain. Idempotent by design.
- **Doctor (auditing, ad-hoc).** `dome doctor` reads the markdown directly and reports any invariant violations the native write introduced (short-form wikilinks, missing index entries, type/directory mismatches, frontmatter schema drift). The user fixes the violation by hand or by re-running the offending operation through Dome.

See [[wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE]] for the formal correctness story this watcher + reconcile loop realizes.

**Edge cases (real but bounded):**

- *Invariant violation by a native write.* A user writes a wiki page in Obsidian with a short-form wikilink (`[[Maya]]` instead of `[[wiki/entities/maya]]`); this violates `WIKILINKS_ARE_FULLPATH`. The next Dome Tool operation on that page fails; `dome doctor` flags it; the user fixes the link. Eventual consistency: the violation is caught and reported, not silently propagated.
- *Daemon off during a burst of native writes.* The watcher doesn't catch them in real time, but `dome reconcile` at next startup catches up via git-diff replay. Cost grows with time-since-reconcile (see [[wiki/gotchas/daemon-off-while-vault-mutating]]).
- *Mid-merge state.* Git in the middle of a merge or rebase has unmerged conflict markers in files. The watcher would otherwise fire events for these, but `dome reconcile` refuses to run under dirty git state (see [[wiki/gotchas/dirty-git-state-at-reconcile]]) so the conflict-marker content doesn't propagate as if it were normal content. The user resolves the merge, commits, and reconcile proceeds.
- *Sync layers (Syncthing, git pull from a peer, iCloud Drive).* Generate native writes when receiving changes from other machines. The watcher treats them identically to local user edits. Each device's `dome serve` reconciles its own view.

**User-facing expectations:**

- "I edited a page in Obsidian and want Dome to catch up" → `dome serve` running keeps the watcher up; no action needed. Without the daemon: `dome reconcile` at next startup catches up.
- "I edited a page and Dome's Tool now refuses to update it" → run `dome doctor`; it lists the violation; fix it.
- "I want Dome to track every edit including manual ones" → `dome serve` keeps the watcher running; `vault.out-of-band-edit` events and their derived `log.md` entries record everything.
- "I want Dome to refuse native edits" → not supported. The vault is yours. Use git pre-commit hooks if you want enforcement at edit time, separate from Dome.

**Obsidian configuration recommendation:**

Set Obsidian's "Default link format" to **"Absolute path in vault"** in Preferences → Files & Links. This makes Obsidian's auto-completed wikilinks compatible with `WIKILINKS_ARE_FULLPATH`. With this setting, native Obsidian edits are unlikely to introduce wikilink violations.

**Related:**
- [[VISION]] §"Two surface patterns" — the architectural framing this gotcha realizes the consumer-shell side of.
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — the axiom this gotcha extends.
- [[wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE]] — the formal correctness story for the watcher + reconcile loop.
- [[wiki/specs/harnesses]] §"What's NOT a harness" and §"The compiler-boundary contract".
- [[wiki/specs/cli]] §"`dome doctor`" and §"`dome reconcile`".
- [[wiki/gotchas/daemon-off-while-vault-mutating]] — adjacent cost-edge.
- [[wiki/gotchas/dirty-git-state-at-reconcile]] — the merge-state edge case.
- [[wiki/entities/obsidian]] §"Recommended settings".
