---
type: gotcha
created: 2026-05-27
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
coverage: off-matrix
description: Native writes (Obsidian, vim, agent Write) are canonical but leave projections and adopted ref stale until the host or dome sync adopts them.
enforced_at: src/cli/commands/serve.ts
enforced_at_status: implemented
first_observed: 2026-05-27
severity: low
---

# Native vault writes (the canonical write path for consumer shells)

**Status note:** The term "out-of-band" survives in this document's title for backward compatibility (cross-references from older substrate cite it), but the framing is *canonical*: native filesystem writes from consumer shells are the primary authoring path under v1's engine model, not a tolerated workaround. Once committed, every native write becomes a Proposal that the engine adopts per [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]]. This document names the failure modes a contributor should know about.

**Scenario:** The user edits a wiki page in Obsidian. Or Claude Code's `Write` tool rewrites a page during a conversation. Or vim edits the file directly. The user commits the change, or `git pull` brings in commits from a remote. The branch now reflects new content; the projections, adopted ref, and any derived state haven't yet caught up.

**Why this is canonical, not a bug:** Markdown is the source of truth ([[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]). Consumer shells write to the filesystem directly because that's the most natural path for the surface they live on — Claude Code has `Write`; Obsidian has its built-in editor; vim has `:w`; git has `pull`. There is no `vault.tools.X(...)` API to compete with; every committed write — agent native write, manual edit, pulled remote change, garden-emitted patch — is unified through the engine's adoption loop per [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] and [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]].

**Structural mechanism (the compiler host → Proposal → adoption pipeline):**

- **Compiler host (primary, low-latency when `dome serve` is running).** The host observes `refs/heads/<branch>` moving ahead of `refs/dome/adopted/<branch>`. On branch movement, it debounces/coalesces, then constructs a `"manual"` Proposal per [[wiki/specs/proposals]] §"Local-eventual mode". Uncommitted working-tree edits remain draft material; they are not trusted state until committed.
- **Sync (secondary, fills the host-off gap).** `dome sync` constructs a Proposal from accumulated commits `refs/dome/adopted/<branch>..HEAD` and routes it through the same adoption loop. Native writes the host missed (host was off, process crashed, branch moved while offline) get caught up. Idempotent by design (per [[wiki/specs/processors]] §"Idempotency" — adoption-phase processors emit the same effects on re-run against the same input).
- **Inspect (auditing, ad-hoc).** `dome inspect diagnostics` reads `projection.db.diagnostics` directly and reports findings from the most recent adoption pass — engine-emitted structural diagnostics and processor-emitted content diagnostics together. The user fixes invariant violations the native write introduced and commits the repair.

See [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]] for the formal correctness story this pipeline realizes.

**Edge cases (real but bounded):**

- *Diagnostic emitted by a native write.* A user writes and commits a wiki page in Obsidian with a broken wikilink; `dome.markdown.validate-wikilinks` emits a `DiagnosticEffect`. The user fixes the link, commits the repair, and syncs again.
- *Compiler host off during a burst of native writes.* The host doesn't catch commits in real time, but `dome sync` at next startup catches up by constructing a single Proposal from the accumulated `adopted..HEAD` range. Cost grows with time-since-sync (see [[wiki/gotchas/daemon-off-while-vault-mutating]]).
- *Mid-merge state.* Git in the middle of a merge or rebase can have unmerged conflict markers in files. Explicit merge/rebase refusal is planned (see [[wiki/gotchas/dirty-git-state-at-reconcile]]) so conflict-marker content doesn't propagate as if it were normal content. The user resolves the merge, commits, and sync proceeds.
- *Sync layers (Syncthing, git pull from a peer, iCloud Drive).* Generate native writes or commits when receiving changes from other machines. Each device's compiler host constructs Proposals from its own branch/adopted view.
- *Raw write attempt.* A user manually edits and commits a `raw/` file. Per [[wiki/invariants/RAW_IS_IMMUTABLE]], v1 blocks raw rewrites at adoption with a `raw.immutable` diagnostic. New raw files can be committed; existing raw evidence cannot be modified or deleted.

**User-facing expectations:**

- "I edited a page in Obsidian and want Dome to catch up" → commit the change. With `dome serve` running, the compiler host adopts it automatically. Without the host: `dome sync` catches up.
- "I edited a page and the next sync reports diagnostics" → run `dome inspect diagnostics`; it lists the findings; fix the issue, commit, and sync again.
- "I want Dome to track every edit including manual ones" → commit coherent edits. `dome serve` keeps the compiler host running; every committed native write becomes a Proposal whose RunRecord lands in the run ledger and whose facts/diagnostics land in projections.
- "I want Dome to refuse native edits" → not supported. The vault is yours. Use git pre-commit hooks if you want enforcement at edit time, separate from Dome.

**Obsidian configuration recommendation:**

Set Obsidian's "Default link format" to **"Absolute path in vault"** in Preferences → Files & Links. This makes Obsidian's auto-completed wikilinks satisfy the `dome.markdown.validate-wikilinks` adoption-phase processor's check. With this setting, native Obsidian edits are unlikely to introduce blocking wikilink diagnostics.

**Related:**
- [[VISION]] §"Two surface patterns" — the architectural framing.
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — the axiom.
- [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]] — the formal correctness story.
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] — the write-path chokepoint.
- [[wiki/specs/proposals]] §"Local-eventual mode" — how the compiler host constructs Proposals.
- [[wiki/specs/harnesses]] §"What's NOT a harness" and §"The compiler-boundary contract".
- [[wiki/specs/cli]] §"`dome sync`".
- [[wiki/gotchas/daemon-off-while-vault-mutating]] — adjacent cost-edge.
- [[wiki/gotchas/dirty-git-state-at-reconcile]] — the merge-state edge case.
- [[wiki/entities/obsidian]] §"Recommended settings".
