# Design Delta Ledger — Phase 1 (adopted ref) + Phase 3 (patch-mediated engine commits)

**Date:** 2026-05-27
**Slug:** `phase-1-3-adopted-ref-and-patch-trailers`
**Branch:** `design/phase-1-3-adopted-ref-and-patch-trailers` (worktree at `.claude/worktrees/design-phase-1-3-adopted-ref-and-patch-trailers`, branched off `main`@`e139ae7`)
**Approved direction source:** `docs/v1.md` §23 ("Minimal implementation roadmap") Phase 1 + Phase 3, distilled in the architecture-review reply in conversation history. The user dispatch is "do Phase 1 and Phase 3 now; rewrite specs, validate, implement cohesively." Phase 2 (the deterministic `compileRange` extraction) is deliberately deferred — its absence does not block either Phase 1 or Phase 3 because the existing `reconcile()` machinery already produces the observation stream those phases need.
**Builds on:** `docs/cohesive/delta-ledgers/2026-05-26-dome-v0.5-to-v1-tightening.md` (the v0.5 → v1 substrate that landed `AbstractSurface`, the four-concept seal, the off-matrix lockstep convention, and the composable-construction `openVault` shape this rewrite extends) and `docs/cohesive/delta-ledgers/2026-05-26-dome-compiler-reframe.md` (the compiler-reframe framing this rewrite makes load-bearing in API and ref shapes).

## Delta at a glance

**Classification:** **Mixed.** Design-layer changes: (a) two new axiom invariants (`ADOPTED_REF_IS_SEMANTIC_CURSOR`, `ENGINE_COMMITS_CARRY_DOME_TRAILERS`) joining the canonical 16-invariant catalog as #17 and #18; (b) one new normative spec, `docs/wiki/specs/adoption.md`, naming the adoption state machine (source range → reconcile → close → adopt) and the `refs/dome/adopted/<branch>` semantics; (c) `cli.md` rewrites: two new shipped commands (`dome sync`, `dome status`) added to the canonical table + "Adding a new command" recipe re-exercised against them + the `--time-since-reconcile` doctor flag documented as adopted-ref-derived going forward; (d) `hooks.md` §"Commit policy" updated — engine commits now carry Dome-* trailers via `commitWorkflow` and a structurally new "closure" commit pass on `dome sync`; (e) `sdk-surface.md` gains §"Adoption surface" naming `getAdoptionStatus` / `sync` as public re-exports from `@dome/sdk` core; (f) `vault-layout.md` retires `last-reconciled-sha.txt` from the derived-operational-state inventory in favor of `refs/dome/adopted/<branch>` + a `last-reconcile-mtime.txt` mtime-only marker preserved solely for `dome doctor --time-since-reconcile`; (g) `event-types-and-payloads.md` matrix adds `engine.adoption.advanced` + `engine.adoption.blocked` events; (h) new gotcha `adopted-ref-divergence` (what happens when adopted ref points at a commit no longer in HEAD's history — fast-forward refuse; force-advance requires explicit flag); (i) `docs/index.md` index extended with the new spec, two invariants, and one gotcha. Implementation-layer changes are dispatched to `cohesive:implement-cohesively` in the same session: new `src/adopted-ref.ts` (read/write the ref via isomorphic-git), new `src/adoption.ts` (the sync loop + status accessor + RunContext factory), `src/workflow-commit.ts` gains a `runContext` parameter and writes Dome-* trailers, `src/workflows/agent-loop.ts` constructs the RunContext per `runWorkflow` invocation, two new CLI commands (`src/cli/commands/sync.ts`, `src/cli/commands/status.ts`), `src/cli/cli.ts` wires them, `src/reconcile.ts` reads adopted ref instead of `last-reconciled-sha.txt` (the file is reduced to the doctor mtime marker `last-reconcile-mtime.txt`), `src/types.ts` extends `INVARIANTS` with the two new entries, `src/index.ts` re-exports the new adoption surface, four new test files (two lockstep tests, two integration tests), and one updated existing test (`workflow-atomic-commit.test.ts` asserts trailers).

**Files:** 4 substrate files added (2 invariants, 1 spec, 1 gotcha). 10 substrate files rewritten (`cli.md`, `hooks.md`, `sdk-surface.md`, `vault-layout.md`, `event-types-and-payloads.md`, `tool-invariant-enforcement.md`, `MARKDOWN_IS_SOURCE_OF_TRUTH.md`, `daemon-off-while-vault-mutating.md`, `AGENTS.md` (repo-root), `docs/index.md`).

**Conceptual changes:** The substrate's v0.5 "compile-reframe" landed the framing that Dome is a compiler over a markdown vault; this rewrite makes the framing **load-bearing in the git ref shape**. The substrate moves from "Dome reconciles every native write into a consistent state, with a side-channel `last-reconciled-sha.txt` marker" to "Dome compiles `adopted..HEAD` and atomically advances `refs/dome/adopted/<branch>` on success." The user-visible difference is small (`dome sync` is mostly `dome reconcile` with a ref advance bolted on; engine commits gain trailers in their message body); the substrate-architecture difference is that the "trusted semantic state" cursor is now a first-class git artifact rather than a `.dome/state/` file, which makes (1) crash recovery derivable from git alone (Phase 1 v1 invariant `HOSTED_MQ_IS_ADMISSION_POLICY` becomes reachable from this Phase 1 substrate without re-plumbing), (2) `git log refs/dome/adopted/main..HEAD` the canonical "what's queued for adoption" query, and (3) the Dome-* trailer convention the structural fence that distinguishes engine-produced from user-produced commits in `git log` and downstream tooling. The two new invariants pin both halves: `ADOPTED_REF_IS_SEMANTIC_CURSOR` pins the ref's role; `ENGINE_COMMITS_CARRY_DOME_TRAILERS` pins the trailer convention's structural enforcement. The v1.md spec's full ambition (staging worktrees, patch-mediated extension effects, Core/Engine/Shell layering, the Analyzer/Handler/View/Command rename, the run ledger, the capability broker, the trust tiers) is **explicitly out of scope** here — those are v1.5–v2 destinations the user's "Where I'd land" architecture-review reply names. This Phase 1+3 rewrite lands the two substrate moves whose payoff is independent of the rest.

**Named invariants:** Two added — `ADOPTED_REF_IS_SEMANTIC_CURSOR` (axiom; pins the ref's existence and meaning); `ENGINE_COMMITS_CARRY_DOME_TRAILERS` (axiom; pins the four-trailer convention on every engine-produced commit). The 16-invariant catalog at `docs/index.md` §"Invariants" + `src/types.ts` `INVARIANTS` grows to 18. AC3 lockstep at `tests/integration/invariant-coverage.test.ts` picks up the additions automatically; the two new `tests/invariants/<slug>.test.ts` files ship in the implementation pass.

**Behavior matrices:** `tool-invariant-enforcement.md` adds two rows declaring the new invariants' enforcement coverage. Both are off-matrix (`ADOPTED_REF_IS_SEMANTIC_CURSOR` enforced at the `src/adoption.ts` advance-ref boundary; `ENGINE_COMMITS_CARRY_DOME_TRAILERS` enforced at `src/workflow-commit.ts`) and follow the delegating-stub shape pinned by `sdk-surface.md` §"Off-matrix lockstep convention". `event-types-and-payloads.md` adds the two new engine events.

**Gotchas:** One added. `adopted-ref-divergence` (the adopted ref can point at a commit that's no longer in HEAD's ancestry after a force-push, hard-reset, or rebase — `dome sync` refuses to advance in that case; `dome status` surfaces the divergence; recovery is `dome sync --force-advance` after the user confirms the new HEAD is the intended trunk). Coverage off-matrix; `enforced_at: src/adoption.ts`.

**Semantic linters:** None added or changed.

## Approved direction (distilled from architecture-review reply)

From the conversation history: the user reviewed the `docs/v1.md` spec and accepted the "Where I'd land" recommendation — land Phase 1 (adopted ref) and Phase 3 (patch-mediated engine closure as trailers) now; defer Phase 2 (compileRange extraction), Phase 4 (defineExtension), Phase 5 (run ledger + capability broker), Phase 6 (graph/query/views), Phase 7 (feature packs) and the Core/Engine/Shell layering refactor; keep the four-concept seal (Vault/Document/Tool/Hook) intact; do NOT introduce Analyzer/Handler/View/Command as new primitives. The substrate framing the user accepted:

> Adopted-ref split is a strict win. … `refs/dome/adopted/main` separate from `refs/heads/main` gives you a "trusted semantic state" cursor queries can default to. … Patches-as-effect-system unifies the internal/external seam. … For Phase 1+3, the right move is to land the adopted ref + the Dome-* trailer convention on engine commits, advance the ref atomically after clean sync; defer the staging-worktree machinery and the extension/permissions rewrite until they're needed.

The user dispatch was "plan them out cohesively and implement … don't ask for my approval, just go all the way through rewriting specs, validating specs, and implementing cohesively." No additional sub-decisions are pending; this delta-ledger is the planning artifact, the spec rewrites + lockstep tests + implementation land in the same session.

## Per-file changes

### Substrate added (4 files)

#### `docs/wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR.md` — new invariant (axiom)

Stable ID for implement-cohesively: `adopted-ref-invariant`.

- **Statement:** `refs/dome/adopted/<branch>` points to the latest commit Dome has fully compiled and considers safe for trusted semantic queries against the named branch. Dome advances it only after `dome sync` completes without blocking diagnostics. Until the ref exists for a branch, `dome status` reports adoption as "uninitialized" and the first `dome sync` initializes it.
- **Tier:** axiom. The ref's existence and meaning is part of what makes Dome Dome under the v1 substrate; no opt-out.
- **Why:** the substrate move from `.dome/state/last-reconciled-sha.txt` (a derived per-machine file) to a first-class git ref means crash recovery, divergence detection, "what is queued for adoption" queries, and future hosted merge-queue semantics are all derivable from git alone. The architecture-review reply names this as the "strict win" of Phase 1.
- **Structural enforcement:** off-matrix. The advance-ref step lives at the `setAdoptedRef` boundary in `src/adoption.ts`; that function is the single chokepoint. Refusing to advance during a non-fast-forward (the divergence case) lives at the same site. The lockstep test `tests/invariants/adopted-ref-is-semantic-cursor.test.ts` follows the delegating-stub convention — it dynamically imports `tests/integration/sync-advances-adopted-ref.test.ts` (and the divergence-refuse test), asserting the structural fence runs there.
- **Counter-example (what this invariant rules out):** a Dome installation that reports its semantic state via `.dome/state/last-reconciled-sha.txt` alone — the file can be deleted, corrupted, or out of sync with reality without `git log` showing anything; the adopted ref is git-tracked, observable in `git show-ref`, and divergent state is structurally detectable.
- **Test guarantee:** `tests/integration/sync-advances-adopted-ref.test.ts` ships in the implementation pass with three cases: (1) fresh vault → `dome sync` initializes the ref at HEAD; (2) source-ahead vault (user commits on top of adopted) → `dome sync` fast-forwards the ref; (3) divergent vault (HEAD's ancestry no longer contains adopted) → `dome sync` refuses to advance, surfacing the divergence; `dome sync --force-advance` accepts the new HEAD.
- **Related:** `[[invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]` (markdown is canonical; the ref is a marker over it), `[[invariants/VAULT_IS_GIT_REPO]]` (the ref exists *in* the git repo), `[[invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE]]` (reconcile advances the ref on clean completion), `[[gotchas/adopted-ref-divergence]]`.

#### `docs/wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS.md` — new invariant (axiom)

Stable ID for implement-cohesively: `engine-trailers-invariant`.

- **Statement:** every commit Dome's engine produces — per-workflow atomic commits, per-sync closure commits, future Phase-3-mediated patches — carries four trailers in the commit message body: `Dome-Run: <run-id>`, `Dome-Extension: <ext-id>`, `Dome-Base: <base-sha>`, `Dome-Source-Head: <source-head-sha>`. User out-of-band commits (the consumer-shell native-write path that lands uncommitted and gets caught by reconcile) do NOT carry these trailers — the structural difference is how `git log --grep="^Dome-Run:"` distinguishes engine-produced from user-produced history.
- **Tier:** axiom. The trailer convention is what makes engine vs. user provenance structurally derivable from git history; no opt-out.
- **Why:** v1.md §4.5 names "every engine-applied patch becomes a visible Git commit" as the patch-mediated closure win. The trailers are the structural anchor for that promise — they make crash recovery (the Run-id can rejoin to the run ledger when one ships), idempotency tracking (the same Dome-Base + Dome-Source-Head pair on a re-run distinguishes "I did this work already" from "I did it on different source"), and audit (`git log` filtered by trailer) all derivable from the commit message itself. Without the convention, engine and user commits are indistinguishable in `git log` and downstream tooling has to maintain a side-channel registry.
- **Structural enforcement:** off-matrix. The trailer construction lives at `src/workflow-commit.ts` `commitWorkflow` — the engine's only commit chokepoint today. The function takes a `runContext: { runId, extensionId, base, sourceHead }` parameter; if the parameter is absent, the function refuses (throws) rather than producing a trailer-less engine commit. The lockstep test `tests/invariants/engine-commits-carry-dome-trailers.test.ts` follows the delegating-stub convention — it dynamically imports `tests/integration/workflow-atomic-commit.test.ts` (which is extended to assert the four trailers are present on every workflow-driven commit).
- **Counter-example (what this invariant rules out):** an extension that writes via `vault.tools.writeDocument` and then calls `git commit` directly bypassing `commitWorkflow`. The trailers would be absent; the commit would be indistinguishable from a user out-of-band edit; provenance would be lost. The structural fence is that `commitWorkflow` is the only function in `src/index.ts`'s re-export set that produces engine commits, and the runContext requirement is the structural fence.
- **Test guarantee:** `tests/integration/workflow-atomic-commit.test.ts` ships extended in the implementation pass; it asserts the four trailers appear on the commit produced by a writeDocument-driving workflow with the expected shape (`Dome-Run: run_<timestamp>_<rand>`, `Dome-Extension: <workflow-name-or-engine>`, `Dome-Base: <sha-40>`, `Dome-Source-Head: <sha-40>`).
- **Related:** `[[invariants/EVERY_WRITE_IS_LOGGED]]` (every write is logged to `log.md`; the trailers extend the provenance story to `git log` symmetrically), `[[invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]]` (the adopted ref + the trailers together define the engine's git-visible footprint).

#### `docs/wiki/specs/adoption.md` — new spec

Stable ID for implement-cohesively: `adoption-spec`.

The normative spec for Phase 1 + Phase 3 substrate. Six sections:

1. **§"The adopted ref"** — defines `refs/dome/adopted/<branch>` semantics. Explicit shape: one ref per source branch (`main` → `refs/dome/adopted/main`; future feature branches each get their own). The first `dome sync` initializes the ref at HEAD; subsequent syncs fast-forward it. Divergence (HEAD no longer descends from adopted) is structurally surfaced and requires explicit `--force-advance` flag.
2. **§"The adoption state machine"** — names the five-step transition (source range identification → reconcile (current machinery; not yet a clean compileRange split) → diagnose (block on blocking diagnostics; today: dirty git state, mid-merge/rebase/cherry-pick) → close (engine-driven closure commit if needed) → adopt (advance ref atomically)). Crash safety: if the process dies before the ref update, prior adopted state remains trusted; if after, adoption succeeded. The state machine maps to the v1.md §4 framing but uses the v0.5 reconcile machinery rather than a from-scratch compileRange.
3. **§"Engine commit trailers"** — names the four-trailer convention (`Dome-Run`, `Dome-Extension`, `Dome-Base`, `Dome-Source-Head`) with one worked example. Names `commitWorkflow`'s `runContext` parameter as the chokepoint. Names the `RunId` shape (`run_<unix-timestamp-ms>_<6-char-random>`) — stable, sortable, debuggable. Names `Dome-Extension: engine` as the value for non-workflow commits (the future closure-pass commits).
4. **§"`dome sync`"** — the new CLI command. Workflow: identify `adopted..HEAD`; run the existing reconcile phases (inbox, git-diff, scheduled); on clean completion (no blocking diagnostics), advance adopted ref atomically; on failure, leave adopted ref unchanged and surface the blocking diagnostic. Names the relationship to `dome reconcile`: `dome reconcile` becomes a deprecated alias that prints a deprecation note and runs `dome sync`. The two commands share the same underlying machinery in `src/adoption.ts`.
5. **§"`dome status`"** — the new CLI command. Output: branch / HEAD / adopted ref / pending commits (`adopted..HEAD`) / dirty tree (uncommitted files + untracked files). Read-only; no mutation. Names the `--json` flag for machine-readable output (mirroring `dome stats --json`).
6. **§"Migration from v0.5"** — what happens to existing vaults. On first `dome sync`, the engine looks for `refs/dome/adopted/<branch>`. If absent, it initializes the ref at HEAD and writes nothing else (skipping the reconcile phases, which would treat every file as "changed since lastSha = null" today — explicitly NOT changed since adopted=HEAD). `.dome/state/last-reconciled-sha.txt` is no longer read after this rewrite; `.dome/state/last-reconcile-mtime.txt` (an mtime-only marker, content-irrelevant) replaces it solely for `dome doctor --time-since-reconcile`. Existing `last-reconciled-sha.txt` files are tolerated (read for the doctor mtime; never written) and removed on the first `dome migrate` invocation. Vaults that were created post-this-rewrite never have `last-reconciled-sha.txt`.

The spec lifts the v1.md §3 + §4 + §13 framing but trims it: no staging worktrees, no patch validation pass (patches are produced inline by the engine and committed directly via isomorphic-git), no separate run ledger (the trailers + git history are the v0.5+phase1+phase3 ledger), no capability broker (extensions remain code-first per the four-concept seal). The trim is what makes the rewrite proportionate — the user's "Where I'd land" reply is the size-discipline anchor.

#### `docs/wiki/gotchas/adopted-ref-divergence.md` — new gotcha

Stable ID for implement-cohesively: `adopted-ref-divergence-gotcha`.

- **Symptom:** after a force-push, hard-reset, or rebase that rewrites HEAD's history, `refs/dome/adopted/<branch>` points at a commit no longer in HEAD's ancestry. `dome sync` refuses to advance ("adopted ref is not an ancestor of HEAD"); `dome status` surfaces the divergence ("adopted: <sha7> (DIVERGED from current branch)").
- **Severity:** medium. The vault is not corrupted — every markdown file is still readable — but Dome's "what is the latest trusted state" cursor is now unreliable for queries until the user resolves the divergence.
- **Coverage:** off-matrix. **Enforced_at:** `src/adoption.ts` `setAdoptedRef`'s fast-forward check.
- **Recovery:** the user inspects the divergence with `git log --oneline <adopted-sha>..HEAD` and `git log --oneline HEAD..<adopted-sha>` to understand what was rewritten. If the new HEAD is the intended trunk (the common case after a `git reset --hard origin/main`), the user runs `dome sync --force-advance` to accept the new HEAD as the adopted ref's new target. If the rewrite was unintentional (the user wanted to keep the prior history), they restore HEAD via `git reflog` / `git reset` and re-run `dome sync` normally.
- **Why the structural fence:** without the fast-forward check, a force-push could silently move adopted to a commit that no longer carries the engine-closure work the prior adopted commit had; future `dome sync` runs would re-do work that was already done (idempotency saves us in practice; the diagnostic saves the user from confusion).
- **Related:** `[[invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]]` (the ref's existence and meaning), `[[gotchas/dirty-git-state-at-reconcile]]` (the sibling "git state is wrong, refuse" gotcha).

### Substrate rewritten (10 files)

#### `docs/wiki/specs/cli.md` — rewrite (3 sections changed)

Stable IDs:

- `cli-sync-command-added` — new §"`dome sync`" section inserted before §"`dome reconcile`". Documents the command's three-phase composition (`adopted..HEAD` range identification → existing reconcile phases run inside the range → ref advance on clean completion). Names the `--force-advance` flag for divergence recovery. Names the relationship to `dome reconcile` (alias with deprecation warning).
- `cli-status-command-added` — new §"`dome status`" section inserted before §"`dome sync`" (so the two new commands sit next to each other in the table). Documents the read-only output (branch / HEAD / adopted / pending / dirty), the `--json` flag, and exit code 0 on success / 1 if the vault open fails. Names this as the SEVEN-DETERMINISTIC-commands list (was five) — the table-wide consistency note: the deterministic commands are now `init`, `doctor`, `serve`, `reconcile`, `sync`, `status`, `stats` (workflow-driven: `lint`, `migrate`, `export-context`).
- `cli-canonical-table-update` — the 8-command table at the top grows to 10 (or, with reconcile-as-alias, 9 distinct commands with `reconcile` documented as the alias). The §"Implementation note" pre-table prose is updated to match. The `--time-since-reconcile` doctor flag is documented as reading from `.dome/state/last-reconcile-mtime.txt` mtime going forward (the deprecation of the old SHA file is named explicitly).

#### `docs/wiki/specs/hooks.md` — rewrite (2 sections changed)

Stable IDs:

- `hooks-commit-policy-trailers` — §"Commit policy" rewritten to name the four-trailer convention. Per-workflow commits carry `Dome-Run: <run-id>`, `Dome-Extension: <workflow-name>`, `Dome-Base: <adopted-sha>`, `Dome-Source-Head: <pre-commit-head-sha>` in the commit message body. The trailers are added by `commitWorkflow` which now requires a `runContext` parameter; the function refuses (throws) if `runContext` is absent. The relationship between the commit subject (`<verb>: <subject>`, byte-identical to the log.md entry) and the trailers (in the body, structurally parseable by `git interpret-trailers`) is named explicitly. User out-of-band edits remain trailer-less.
- `hooks-durability-adopted-ref` — §"Durability and reconciliation" updated. The "state-based reconciliation" mechanism still rests on the three observations (vault is canonical; git tracks every content change; inbox files signal pending work) but the cursor is now `refs/dome/adopted/<branch>` rather than `.dome/state/last-reconciled-sha.txt`. Reconcile phase 2's "git diff since lastSha" becomes "git diff `adopted..HEAD`". The recovery table is unchanged (every case still derivable from git + filesystem); the table's mention of `last-reconciled-sha.txt` is replaced with `refs/dome/adopted/<branch>`. The §"Derived operational state" table loses `last-reconciled-sha.txt` and gains `last-reconcile-mtime.txt` (the mtime-only marker that survives only for `dome doctor --time-since-reconcile`'s age check).

#### `docs/wiki/specs/sdk-surface.md` — rewrite (2 sections added)

Stable IDs:

- `sdk-adoption-surface` — new §"Adoption surface" section inserted before §"Consumer surfaces". Documents `sync(vault, opts): Promise<Result<SyncResult, ToolError>>` and `getAdoptionStatus(vault): Promise<AdoptionStatus>` as the two new public re-exports from `@dome/sdk` core. Both live in `src/adoption.ts`. The `SyncResult` shape and the `AdoptionStatus` shape are named with their TypeScript signatures. The relationship to existing `reconcile()` is named — `sync` is `reconcile` + ref-advance; `reconcile` stays exported for back-compat consumers but the spec recommends `sync` for new code.
- `sdk-workflow-commit-runcontext` — §"Commit policy" subsection rewritten to name `commitWorkflow`'s new `runContext: { runId, extensionId, base, sourceHead }` parameter. The pre-rewrite signature `commitWorkflow(vault, { verb, subject, body?, touchedPaths, author? })` becomes `commitWorkflow(vault, { verb, subject, body?, touchedPaths, runContext, author? })`. The function refuses when `runContext` is absent — the structural fence for `ENGINE_COMMITS_CARRY_DOME_TRAILERS`. The §"Outputs the SDK does not have" anti-concept list is unchanged.

#### `docs/wiki/specs/vault-layout.md` — rewrite (1 section)

Stable ID: `vault-layout-state-marker-rename`.

§"Derived operational state under `.dome/`" updated. `last-reconciled-sha.txt` is renamed (functionally) to `last-reconcile-mtime.txt` and demoted from canonical "what have I seen" to a touched-file-only marker whose only consumer is `dome doctor --time-since-reconcile`. The canonical "what have I seen" cursor moves to `refs/dome/adopted/<branch>`. The table's row for the renamed file gets a new "Purpose" string ("Mtime marker for `dome doctor --time-since-reconcile`; touched on every `dome sync` regardless of whether anything changed."). The "If deleted" column changes from "Next reconcile treats every file as changed" to "Next `dome doctor --time-since-reconcile` reports 'never'". The migration semantics are deferred to `adoption.md` §"Migration from v0.5" (this spec just names the new shape).

#### `docs/wiki/matrices/event-types-and-payloads.md` — rewrite (1 row pair added)

Stable ID: `event-matrix-engine-adoption-events`.

Adds two rows for the new lifecycle events:

- `engine.adoption.advanced` — emitted by `src/adoption.ts` after `setAdoptedRef` succeeds. Payload: `{ branch: string; from: CommitOid | null; to: CommitOid; runId: string }`. Example consumer: a future Dome-aware shell that watches for adoption advances to refresh its query cache; the v0.5 ship does not register any handler for the event.
- `engine.adoption.blocked` — emitted by `src/adoption.ts` when `sync` cannot advance (dirty git state, divergence, blocking diagnostic). Payload: `{ branch: string; adopted: CommitOid | null; head: CommitOid; reason: string }`. Example consumer: same as above; v0.5 ships unhandled.

Both events are documented in the matrix with the projected event-name dot-pattern (per `[[hooks.md]]` §"Bare events expand to suffix wildcards" — bare-form is just the event name and gets `.*` suffix on registration, but the engine emits the literal event with the kind set to the full name).

#### `docs/wiki/matrices/tool-invariant-enforcement.md` — rewrite (2 rows added)

Stable ID: `matrix-engine-trailer-adopted-ref-rows`.

Adds two off-matrix rows declaring the new invariants' enforcement coverage:

- `ADOPTED_REF_IS_SEMANTIC_CURSOR` (off-matrix; **enforced_at:** `src/adoption.ts` `setAdoptedRef` + `tests/integration/sync-advances-adopted-ref.test.ts`).
- `ENGINE_COMMITS_CARRY_DOME_TRAILERS` (off-matrix; **enforced_at:** `src/workflow-commit.ts` `commitWorkflow` + `tests/integration/workflow-atomic-commit.test.ts`).

The §"Lockstep status" subsection's documentary-status declaration extends to cover both new invariants.

#### `docs/wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH.md` — rewrite (1 paragraph)

Stable ID: `markdown-source-of-truth-derived-zone`.

§"The explicit 'derived' zone under `.dome/`" prose updated. Mentions the renamed mtime marker (`last-reconcile-mtime.txt`); cross-links the `refs/dome/adopted/<branch>` cursor and `ADOPTED_REF_IS_SEMANTIC_CURSOR` invariant for the canonical "what has been compiled" semantics. The structural enforcement (every read goes through the filesystem; every write mutates a markdown file) is unchanged.

#### `docs/wiki/gotchas/daemon-off-while-vault-mutating.md` — rewrite (whole gotcha)

Stable ID: `daemon-off-gotcha-rewrite`.

The gotcha was cited from `cli.md` §"`dome doctor` --time-since-reconcile" as the canonical reference for the cursor-rename migration story; it had to be rewritten in lockstep. The rewrite: replaces every `last-reconciled-sha.txt` reference with the canonical `refs/dome/adopted/<branch>` cursor (and the renamed mtime marker for the doctor flag); updates the canonical command from `dome reconcile` to `dome sync` (noting the deprecated alias for back-compat); adds `dome status` as the snapshot-surface mitigation; adds a "do not manually delete the adopted ref" caveat; adds a cross-link to the new sibling `adopted-ref-divergence` gotcha.

#### `AGENTS.md` (repo-root) — rewrite (1 line)

Stable ID: `agents-md-invariant-count`.

The "named invariants are pinned by AC3 lockstep" line drops the inline count (was "16 named invariants"; now "named invariants" with a `[[substrate-count-drift]]` cross-reference). Avoids the count needing edits when invariants are added.

#### `docs/index.md` — rewrite (3 sections extended)

Stable ID: `index-md-phase-1-3-entries`.

- §"Specs" — add `[[wiki/specs/adoption]]` with one-liner ("The adoption state machine, the `refs/dome/adopted/<branch>` semantics, and the Dome-* trailer convention on engine commits.").
- §"Invariants" — add `[[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]]` and `[[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]]` with their one-line summaries and tier markers (*(axiom)* for both). The catalog count climbs from 16 to 18.
- §"Gotchas" — add `[[wiki/gotchas/adopted-ref-divergence]]` with its one-line summary.

### Implementation work this delta-ledger implies

The implementation pass (dispatched via `cohesive:implement-cohesively`) lands the following code-side changes. Each is keyed to the stable IDs above.

**New code files:**

1. **`src/adopted-ref.ts`** (`adopted-ref-invariant`). Three exported functions:
   - `getCurrentBranch(vaultPath: string): Promise<string>` — reads `.git/HEAD` and returns the branch name (or throws if HEAD is detached).
   - `getAdoptedRef(vaultPath: string, branch?: string): Promise<string | null>` — reads `refs/dome/adopted/<branch>` via isomorphic-git, returns null if unset.
   - `setAdoptedRef(vaultPath: string, branch: string, sha: string, opts?: { forceAdvance?: boolean }): Promise<Result<void, ToolError>>` — fast-forward-only by default; refuses if sha is not a descendant of the current ref value; `forceAdvance: true` overrides.
2. **`src/adoption.ts`** (`adoption-spec`). Four exported items:
   - `RunContext` type: `{ runId: string; extensionId: string; base: string; sourceHead: string }`.
   - `makeRunContext(opts: { extensionId: string; base: string; sourceHead: string }): RunContext` — generates the `runId` as `run_<unix-ms>_<6-char-random>`.
   - `sync(vault: Vault, opts?: { forceAdvance?: boolean }): Promise<Result<SyncResult, ToolError>>` — identifies `adopted..HEAD`; runs the existing `reconcile()` machinery; on clean completion advances the adopted ref; emits `engine.adoption.advanced` or `engine.adoption.blocked` events.
   - `getAdoptionStatus(vault: Vault): Promise<AdoptionStatus>` — returns `{ branch, head, adopted, pendingCommits, dirty }` for `dome status`.
3. **`src/cli/commands/sync.ts`** (`cli-sync-command-added`). Single `domeSync(vaultPath, opts)` export.
4. **`src/cli/commands/status.ts`** (`cli-status-command-added`). Single `domeStatus(vaultPath, opts)` export. Supports `--json` (machine-readable JSON output mirroring `dome stats --json`).

**Modified code files:**

5. **`src/workflow-commit.ts`** (`engine-trailers-invariant`, `sdk-workflow-commit-runcontext`). The `WorkflowCommitInput` interface gains a required `runContext: RunContext` field. The `commitWorkflow` function constructs the commit message body as `<input.body ?? ""><sep>Dome-Run: <runId>\nDome-Extension: <extensionId>\nDome-Base: <base>\nDome-Source-Head: <sourceHead>` (the trailers separated from any body by a blank line per `git interpret-trailers` convention). If `runContext` is absent, the function throws.
6. **`src/workflows/agent-loop.ts`** (`engine-trailers-invariant`). The `runWorkflow` function captures `base = await getAdoptedRef(vault.path, branch) ?? "0".repeat(40)` and `sourceHead = await resolveRef({ path: vault.path })` before `generateText`; after `generateText` returns and before `commitWorkflow`, it constructs the `RunContext` via `makeRunContext({ extensionId: workflowName, base, sourceHead })` and threads it into the commit call.
7. **`src/reconcile.ts`** (`hooks-durability-adopted-ref`, `vault-layout-state-marker-rename`). Phase 2 reads adopted ref (via `getAdoptedRef`) instead of `last-reconciled-sha.txt`. After successful completion, writes `.dome/state/last-reconcile-mtime.txt` (mtime-only marker; content can be the same SHA as adopted for forward-debugging, but doctor reads mtime only) rather than `last-reconciled-sha.txt`. The deprecated `last-reconciled-sha.txt` file is no longer read; on first encounter, an empty `last-reconcile-mtime.txt` is created and the old file is left in place (the doctor falls back to the old file's mtime when the new one doesn't exist, smoothing the migration).
8. **`src/cli/cli.ts`** (`cli-sync-command-added`, `cli-status-command-added`). Two new `.command(...).action(...)` arms wired before `reconcile` (alphabetical ordering: doctor/init/lint/migrate/reconcile/serve/stats/sync/status/export-context — but for help-text legibility, the help-text "Examples" block also gains a `dome sync` line).
9. **`src/cli/commands/doctor.ts`** (`cli-canonical-table-update`). The `--time-since-reconcile` flag's `reconcilePath` constant changes from `last-reconciled-sha.txt` to `last-reconcile-mtime.txt`; the fallback when the new file doesn't exist reads the old file's mtime (zero-effort migration). The "never" path is unchanged.
10. **`src/cli/commands/reconcile.ts`** (`cli-sync-command-added`). Augmented to print a deprecation note ("dome reconcile is deprecated; use dome sync") on stderr and then delegate to `domeSync(vaultPath)`. Existing callers continue to work; new callers are nudged toward `dome sync`.
11. **`src/types.ts`** (`adopted-ref-invariant`, `engine-trailers-invariant`). The `INVARIANTS` object gains two entries:
    - `ADOPTED_REF_IS_SEMANTIC_CURSOR: "ADOPTED_REF_IS_SEMANTIC_CURSOR"`.
    - `ENGINE_COMMITS_CARRY_DOME_TRAILERS: "ENGINE_COMMITS_CARRY_DOME_TRAILERS"`.
12. **`src/index.ts`** (`sdk-adoption-surface`). Re-exports the new adoption surface:
    - `export { sync, getAdoptionStatus, makeRunContext, type RunContext, type SyncResult, type AdoptionStatus } from "./adoption";`
    - `export { getAdoptedRef, getCurrentBranch } from "./adopted-ref";` (the `setAdoptedRef` write side is internal; consumers don't write the ref directly).
    - The existing `commitWorkflow` re-export stays; the type signature change is type-system-level.
13. **`src/git.ts`** — gains thin wrappers for the isomorphic-git `writeRef` / `expandRef` calls `adopted-ref.ts` needs.

**New test files (4):**

14. **`tests/invariants/adopted-ref-is-semantic-cursor.test.ts`** — delegating-stub pattern (`adopted-ref-invariant`). Imports `../integration/sync-advances-adopted-ref.test` to run the structural fence.
15. **`tests/invariants/engine-commits-carry-dome-trailers.test.ts`** — delegating-stub pattern (`engine-trailers-invariant`). Imports `../integration/workflow-atomic-commit.test`.
16. **`tests/integration/sync-advances-adopted-ref.test.ts`** — three integration cases per the invariant doc's "Test guarantee" section (fresh / fast-forward / divergent).
17. **`tests/integration/dome-status-output.test.ts`** — three cases: clean vault (adopted == HEAD, no pending, no dirty); source-ahead vault (adopted != HEAD, pending > 0); dirty-tree vault (uncommitted files surfaced).

**Modified test file (1):**

18. **`tests/integration/workflow-atomic-commit.test.ts`** — the existing three tests get a fourth assertion each: the resulting commit's message body parses with `git interpret-trailers` to yield the four expected Dome-* trailer keys, and the values match the expected shape (`Dome-Run` regex-matches `^run_\d+_[a-z0-9]{6}$`, `Dome-Base` and `Dome-Source-Head` regex-match `^[0-9a-f]{40}$`, `Dome-Extension` equals the workflow name).

**Invariant lockstep — automatic:**

The AC3 lockstep test at `tests/integration/invariant-coverage.test.ts` iterates `Object.entries(INVARIANTS)` and requires `tests/invariants/<slug>.test.ts` for each named invariant. Adding the two new entries to `INVARIANTS` plus shipping the two new lockstep test files satisfies AC3 without any change to `invariant-coverage.test.ts` itself.

## Concept relationships affected

The "Engine commit" concept is new in the substrate — pre-rewrite, `commitWorkflow` produced "workflow commits" with no explicit provenance. Post-rewrite, the term "engine commit" is well-defined: any commit produced by `src/workflow-commit.ts` (today the only chokepoint) or future closure-pass commits in `src/adoption.ts` (deferred; Phase-3-as-trailers covers the present need without a separate closure pass). The structural distinction between engine and user commits is the four-trailer convention; `git log --grep="^Dome-Run:"` is the canonical engine-history query.

The "Adoption" concept is new in the substrate — pre-rewrite, the closest analogue was "reconcile state" tracked by `last-reconciled-sha.txt`. Post-rewrite, "adoption" is well-defined: the state machine in `adoption.md` §"The adoption state machine"; the ref shape in §"The adopted ref"; the trailers in §"Engine commit trailers". The state machine is intentionally simpler than v1.md §4's six-step version (skipping staging worktrees and patch validation because the existing reconcile machinery already produces the observation stream those steps were designed to gate).

## What this rewrite explicitly does NOT do

Bullet form to make the size-discipline anchor visible:

- Does NOT extract a deterministic `compileRange` (v1.md §5, Phase 2). The existing `reconcile()` is the de-facto compiler for `adopted..HEAD` work; extracting it cleanly is a future rewrite.
- Does NOT introduce staging worktrees (v1.md §4.2). Patches apply directly to HEAD; the "atomic" property is at the ref level (advance happens or doesn't) rather than at the worktree level.
- Does NOT introduce `defineExtension`, the manifest schema, or the permission model (v1.md §7–§9, Phase 4). The four-concept seal (Vault/Document/Tool/Hook) and the existing extension-bundle mechanism stay.
- Does NOT introduce the run ledger, capability broker, or idempotency-key registry (v1.md §16, Phase 5). The Dome-* trailers carry enough provenance for v0.5+phase1+phase3; a real run ledger is deferred.
- Does NOT introduce GraphFacts, the graph projection, or `dome.query` (v1.md §15, Phase 6). Queries continue to read live state via existing Tool surfaces; the adopted ref is a marker, not yet a query target.
- Does NOT rename Tool/Hook to Analyzer/Handler/View/Command (v1.md §11). The four-concept seal stays intact.
- Does NOT introduce the Core/Engine/Shell layering refactor (v1.md §2). The current `src/` layout is preserved; `src/adoption.ts` is one new file at the same level as `src/reconcile.ts`.
- Does NOT change query default behavior to point at the adopted ref instead of HEAD. Phase 1's v1.md framing names "queries default to adopted" as a goal; this rewrite ships the ref but not the query-target shift. The shift is a follow-on that depends on the graph projection (Phase 6); deferring it keeps the substrate move small.

The deferrals are the architecture-review reply's "Where I'd land" recommendation made literal in scope. A future "Phase 2" or "Phase 4" or "Phase 6" rewrite picks up each one when the use case for it materializes.

## What changes that are NOT spec-rewrites?

Two implementation-only changes that don't have a spec-rewrite delta entry but should appear in the implementation pass:

- **`src/cli/cli.ts`**'s help-text "Examples" block gains a `dome sync` and `dome status` line (no spec entry; this is help-text only).
- **`bin/dome`** is unchanged — `runCli` already dispatches to the new commands once `cli.ts` wires them.

## Open questions resolved at planning time (no user input pending)

- **Q: Should `dome reconcile` be retired entirely, or kept as an alias?** Resolved: kept as a deprecated alias. Retiring it would break existing test fixtures and harness invocations; the deprecation note nudges new callers without breaking existing ones.
- **Q: Should `last-reconciled-sha.txt` be removed or renamed?** Resolved: renamed to `last-reconcile-mtime.txt`, content downgraded to "mtime-only marker." The doctor flag remains semantically the same; the rename is the structural fence against the file's old "what have I seen" role being relied on.
- **Q: Should `commitWorkflow`'s `runContext` be optional (backwards-compatible) or required?** Resolved: required. The structural fence for `ENGINE_COMMITS_CARRY_DOME_TRAILERS` depends on the function refusing to produce a trailer-less commit. The single caller (`runWorkflow`) is updated in this rewrite; if a future caller wants to commit without a runContext, that's a sign they shouldn't be using `commitWorkflow` (they should be making a user out-of-band commit via `git.commit` directly, which is the path the consumer-shell surface uses).
- **Q: How does the adopted ref interact with multi-branch workflows?** Resolved: one ref per branch. `refs/dome/adopted/main` is the v0.5 case (single-branch vaults). Future multi-branch vaults get `refs/dome/adopted/feature-x` per branch automatically — the `getCurrentBranch` function returns the current branch and the ref machinery namespaces by it. This matches v1.md §3.1.
- **Q: What is the `Dome-Extension` value for `dome migrate` / `dome lint` / future engine-driven non-workflow commits?** Resolved: workflow names take precedence (`Dome-Extension: ingest`, `Dome-Extension: lint`, etc.). For future closure-pass commits made directly by `src/adoption.ts` (not via a workflow), the value is `engine`.

## Implementation order (one session)

1. Add the two new invariants to `src/types.ts` `INVARIANTS`.
2. Implement `src/adopted-ref.ts` + the `src/git.ts` `writeRef` / `expandRef` shims.
3. Implement `src/adoption.ts` (sync + getAdoptionStatus + makeRunContext + types).
4. Modify `src/workflow-commit.ts` to require + emit `runContext`.
5. Modify `src/workflows/agent-loop.ts` to build the `runContext` and thread it.
6. Modify `src/reconcile.ts` to read adopted ref instead of `last-reconciled-sha.txt`; rename the state file.
7. Modify `src/cli/commands/doctor.ts` for the renamed state file (with fallback).
8. Implement `src/cli/commands/sync.ts` + `src/cli/commands/status.ts`.
9. Modify `src/cli/cli.ts` to wire the two new commands.
10. Modify `src/cli/commands/reconcile.ts` to delegate to `domeSync`.
11. Update `src/index.ts` re-exports.
12. Land the four new test files + the one modified test file.
13. Run `bun test` and confirm all 18 invariants' AC3 lockstep passes (the two new entries automatically pick up).

Steps 1–11 are the substrate; 12 is the lockstep; 13 is the green-light gate. The implementation pass also produces the substrate-discovery report and the substrate model artifacts cohesive expects.
