---
type: gotcha
created: 2026-05-27
updated: 2026-05-27
severity: low
coverage: off-matrix
enforced_at: src/watcher.ts
enforced_at_status: deferred  # v0.5 path retired; v1 enforcement TBD in later phase
first_observed: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# Native vault writes (the canonical write path for consumer shells)

**Status note:** The term "out-of-band" survives in this document's title for backward compatibility (cross-references from older substrate cite it), but the framing is *canonical*: native filesystem writes from consumer shells are the primary write path under v1's engine model, not a tolerated workaround. Every native write becomes a Proposal that the engine adopts per [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]]. This document names the failure modes a contributor should know about.

**Scenario:** The user edits a wiki page in Obsidian. Or Claude Code's `Write` tool rewrites a page during a conversation. Or vim edits the file directly. Or `git pull` brings in changes from a remote. The page now reflects new content; the projections, adoption ref, and any derived state hasn't yet caught up.

**Why this is canonical, not a bug:** Markdown is the source of truth ([[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]). Consumer shells write to the filesystem directly because that's the most natural path for the surface they live on — Claude Code has `Write`; Obsidian has its built-in editor; vim has `:w`; git has `pull`. There is no `vault.tools.X(...)` API to compete with; every write — programmatic Submit, agent native write, manual edit — is unified through the engine's adoption loop per [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] and [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]].

**Structural mechanism (the watcher → Proposal → adoption pipeline):**

- **Watcher (primary, real-time when `dome serve` is running).** `VaultWatcher` (chokidar) observes `wiki/`, `inbox/`, `raw/`, and `notes/`. On any filesystem change, it debounces, then calls `vault.submitProposal()` per [[wiki/specs/proposals]] §"Local-eventual mode". The Proposal source kind is `"manual"` for unknown originators, `"agent"` when `$DOME_HARNESS` is set, `"client"` for known native shells.
- **Sync (secondary, fills the daemon-off gap).** `dome sync` constructs a Proposal from the working-tree state plus accumulated commits `refs/dome/adopted/<branch>..HEAD` and routes it through the same adoption loop. Native writes the watcher missed (daemon was off, OS event coalescing under load) get caught up. Idempotent by design (per [[wiki/specs/processors]] §"Idempotency" — adoption-phase processors emit the same effects on re-run against the same input).
- **Show (auditing, ad-hoc).** `dome inspect diagnostics` reads `projection.db.diagnostics` directly and reports findings from the most recent adoption pass — engine-emitted structural diagnostics and processor-emitted content diagnostics together. The user fixes invariant violations the native write introduced and re-submits.

See [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]] for the formal correctness story this pipeline realizes.

**Edge cases (real but bounded):**

- *Diagnostic emitted by a native write.* A user writes a wiki page in Obsidian with a short-form wikilink (`[[Maya]]` instead of `[[wiki/entities/maya]]`); `dome.markdown.validate-wikilinks` (adoption-phase processor) emits a `DiagnosticEffect` with severity `block`. The Proposal blocks. The user fixes the link (or runs `dome lint --apply` on the proposed correction) and resubmits.
- *Daemon off during a burst of native writes.* The watcher doesn't catch them in real time, but `dome sync` at next startup catches up by constructing a single Proposal from the accumulated `adopted..HEAD` range plus working-tree diff. Cost grows with time-since-sync (see [[wiki/gotchas/daemon-off-while-vault-mutating]]).
- *Mid-merge state.* Git in the middle of a merge or rebase has unmerged conflict markers in files. `dome sync` refuses to run under dirty git state (see [[wiki/gotchas/dirty-git-state-at-reconcile]]) so the conflict-marker content doesn't propagate as if it were normal content. The user resolves the merge, commits, and sync proceeds.
- *Sync layers (Syncthing, git pull from a peer, iCloud Drive).* Generate native writes when receiving changes from other machines. The watcher treats them identically to local user edits. Each device's `dome serve` constructs Proposals from its own view.
- *Raw write attempt.* A user manually edits a `raw/` file. Per [[wiki/invariants/RAW_IS_IMMUTABLE]], the next Proposal containing the raw mutation blocks at the adoption phase with a `raw.immutable` diagnostic. The user reverts via `git restore` (or submits with `--force-advance` to consciously accept the raw rewrite, which the diagnostic message documents).

**User-facing expectations:**

- "I edited a page in Obsidian and want Dome to catch up" → `dome serve` running keeps the watcher active; no action needed. Without the daemon: `dome sync` at next startup catches up.
- "I edited a page and the next sync is blocked" → run `dome inspect diagnostics`; it lists the findings; fix the issue and resubmit.
- "I want Dome to track every edit including manual ones" → `dome serve` keeps the watcher running; every native write becomes a Proposal whose RunRecord lands in `runs.db` and projection into `log.md`.
- "I want Dome to refuse native edits" → not supported. The vault is yours. Use git pre-commit hooks if you want enforcement at edit time, separate from Dome.

**Obsidian configuration recommendation:**

Set Obsidian's "Default link format" to **"Absolute path in vault"** in Preferences → Files & Links. This makes Obsidian's auto-completed wikilinks satisfy the `dome.markdown.validate-wikilinks` adoption-phase processor's check. With this setting, native Obsidian edits are unlikely to introduce blocking wikilink diagnostics.

**Related:**
- [[VISION]] §"Two surface patterns" — the architectural framing.
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — the axiom.
- [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]] — the formal correctness story.
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] — the write-path chokepoint.
- [[wiki/specs/proposals]] §"Local-eventual mode" — how the watcher constructs Proposals.
- [[wiki/specs/harnesses]] §"What's NOT a harness" and §"The compiler-boundary contract".
- [[wiki/specs/cli]] §"`dome sync`".
- [[wiki/gotchas/daemon-off-while-vault-mutating]] — adjacent cost-edge.
- [[wiki/gotchas/dirty-git-state-at-reconcile]] — the merge-state edge case.
- [[wiki/entities/obsidian]] §"Recommended settings".
