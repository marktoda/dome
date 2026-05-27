---
type: spec
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/delta-ledgers/2026-05-27-phase-1-3-adopted-ref-and-patch-trailers]]"]
---

# Adoption

This spec is normative for Dome's adoption substrate — the `refs/dome/adopted/<branch>` ref, the adoption state machine, the Dome-* trailer convention on engine commits, and the two new CLI commands (`dome sync` + `dome status`) that surface the substrate to consumers.

The adoption substrate is the v1 spec's [Phase 1 + Phase 3] move (`docs/v1.md` §23) landed proportionately on top of the v0.5 four-concept core. It does NOT introduce staging worktrees, a clean `compileRange` extraction, a run ledger, a capability broker, or the Core/Engine/Shell layering refactor — those are v1.5+ destinations. What it does land is a first-class git artifact for "the latest fully compiled revision" and a structural fence (the four trailers) that distinguishes engine-produced commits from user-produced commits in `git log`.

## The adopted ref

`refs/dome/adopted/<branch>` is the canonical "trusted semantic state" cursor for the named source branch. It points to the latest commit Dome has fully compiled and considers safe for trusted semantic queries. The engine advances it only after `dome sync` completes without blocking diagnostics.

```text
refs/heads/main                  user/client source branch (humans, agents, editors write here)
refs/dome/adopted/main           latest fully adopted semantic state for `main`
```

One ref per source branch. A vault that uses `main` as its only branch carries `refs/dome/adopted/main`; future multi-branch vaults get `refs/dome/adopted/feature-x` per branch automatically.

Until the ref exists for a branch (a freshly-init'd vault, or a vault upgrading from v0.5), `dome status` reports adoption as "uninitialized" and the next `dome sync` initializes the ref at HEAD without running the reconcile phases (initialization treats HEAD as already-compiled — explicitly NOT a backlog of unseen work).

After initialization, the source branch may run ahead of the adopted ref:

```text
main:                  A --- B --- C
refs/dome/adopted/main A
```

After `dome sync` succeeds:

```text
main:                  A --- B --- C
refs/dome/adopted/main             C
```

Or, when sync produces an engine-closure commit `D` (e.g., an auto-update-index write that needed to commit) on top of `C`:

```text
main:                  A --- B --- C --- D
refs/dome/adopted/main                 D
```

The ref always points to a commit reachable from `HEAD`. Fast-forward-only advance: if HEAD's ancestry no longer contains the current adopted commit (a force-push, hard-reset, or rebase rewrote history), `dome sync` refuses and the user resolves the divergence via `dome sync --force-advance` after confirming the new HEAD is the intended trunk. See [[wiki/gotchas/adopted-ref-divergence]].

## The adoption state machine

```text
source range
  → reconcile
  → diagnose
  → close
  → adopt
```

### Source range

Dome identifies the range as `adopted..HEAD` for the current branch. The range may be empty (`adopted == HEAD`; no work to do) or contain user commits, engine-closure commits, or both.

### Reconcile

Dome runs the existing three-phase `reconcile()` machinery (per [[wiki/specs/hooks]] §"Durability and reconciliation"):

1. Inbox processing — fires `document.written.inbox.<bucket>` for each file in `inbox/<bucket>/`.
2. Git-diff replay — fires `document.written.<category>.<type>` for each file changed in `adopted..HEAD` plus the working-tree diff.
3. Scheduled catch-up — fires `clock.tick.<interval>` for each scheduled hook whose interval has elapsed.

The reconcile machinery is the v0.5+phase1+phase3 stand-in for the v1.md §5 deterministic `compileRange`. A future Phase 2 rewrite extracts it cleanly; the substrate ships against the existing machinery because that's what's there.

### Diagnose

Blocking diagnostics stop adoption. The v0.5+phase1+phase3 set of blocking conditions:

- Dirty git state (mid-merge, mid-rebase, mid-cherry-pick) — per [[wiki/gotchas/dirty-git-state-at-reconcile]].
- Adopted ref divergence (HEAD's ancestry does not contain the current adopted commit) — per [[wiki/gotchas/adopted-ref-divergence]].
- Reconcile-phase error that aborts the sync (corrupt `.dome/state/scheduled.json`, unreadable inbox, etc.).

If adoption blocks, the source branch remains ahead; the adopted ref remains unchanged; the engine emits an `engine.adoption.blocked` event with the reason. The user resolves the diagnostic and re-runs `dome sync`.

### Close

If the reconcile phases produced uncommitted engine-driven changes (today: never, because per-workflow atomic commits land each workflow's work as a commit; future: a closure pass that batches multiple hook-driven writes into a single closure commit), the engine creates a closure commit at this step. Closure commits carry the four Dome-* trailers (§"Engine commit trailers" below) with `Dome-Extension: engine`.

In v0.5+phase1+phase3, the close step is a no-op for most syncs — the work that *would* be a closure commit has already happened inside the per-workflow atomic commits that produced HEAD. The step is named explicitly because Phase 4+'s closure-pass machinery slots in here without reshape.

### Adopt

The engine atomically updates `refs/dome/adopted/<branch>` to the current HEAD. If the process crashes before this step, the previous adopted state remains trusted. If it crashes after, adoption succeeded.

On success the engine emits `engine.adoption.advanced` with `{ branch, from, to, runId }` payload.

## Engine commit trailers

Every commit Dome's engine produces carries four trailers in the commit message body:

```text
ingest: capture an Atlas entity page

Dome-Run: run_1748313600000_a3f9b2
Dome-Extension: ingest
Dome-Base: 9c1e002dccda2a51df8e9c10a5cd8c14f5a08a2b
Dome-Source-Head: 41a98c2bba39b4b1a8bcd6f9d8b2c4a3e5f6a7b8
```

The trailers sit after a blank line per `git interpret-trailers` convention. They are structurally parseable: `git interpret-trailers --parse <commit-message>` yields the four key/value pairs.

Trailer roles:

- **`Dome-Run`** — a run id of the form `run_<unix-ms>_<6-char-random>`, generated per workflow invocation (or per closure-pass batch). Sortable by timestamp; debuggable in logs; the anchor that ties a commit to its run-time context.
- **`Dome-Extension`** — the source of the commit. For per-workflow atomic commits, this is the workflow name (`ingest`, `lint`, `migrate`, etc.). For closure-pass commits made directly by the engine (future Phase 4+), this is `engine`. Plugin/bundle-driven workflows in a future Phase 4+ carry the bundle's extension id.
- **`Dome-Base`** — the SHA of `refs/dome/adopted/<branch>` at the moment the run started. If adopted was uninitialized, the value is the all-zeros SHA `0000000000000000000000000000000000000000`. Used by future idempotency-key registries to determine "I did this work against this base before."
- **`Dome-Source-Head`** — the SHA of HEAD at the moment the run started (before this commit was made). Distinct from `Dome-Base` whenever the user has commits on top of adopted that the run is reacting to.

User out-of-band edits (the consumer-shell native-write path: vim, Obsidian, Claude Code's native `Write`, etc.) commit through normal `git commit` and do **not** carry these trailers. The structural difference is what makes `git log --grep="^Dome-Run:"` the canonical "engine history" query and `git log --invert-grep --grep="^Dome-Run:"` the user-history query.

The convention is pinned by [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]]: `commitWorkflow` is the single chokepoint for engine commits and requires a `runContext` parameter; the function refuses (throws) if the parameter is absent. There is no path to producing a trailer-less engine commit.

## `dome sync`

The new CLI command. Runs the adoption state machine against the current branch.

```bash
cd ~/vaults/work && dome sync
cd ~/vaults/work && dome sync --force-advance  # accept divergent HEAD after manual confirmation
```

Composition (in order):

1. **Identify source range** — read `refs/dome/adopted/<branch>` (initialize at HEAD if absent); range = `adopted..HEAD`.
2. **Diagnose preconditions** — refuse on dirty git state (mid-merge, mid-rebase, mid-cherry-pick); refuse on divergence unless `--force-advance` is set.
3. **Reconcile** — run the existing `reconcile()` machinery (inbox → git-diff → scheduled). Hooks fire, engine writes commit via `commitWorkflow` with Dome-* trailers.
4. **Drain hooks** — wait for the async hook queue to settle (matches `dome reconcile`'s current behavior).
5. **Adopt** — atomically advance `refs/dome/adopted/<branch>` to current HEAD. Emit `engine.adoption.advanced`.

Output:

```text
dome sync: adopted main: 9c1e002..41a98c2 (3 user commits, 2 engine commits, 0 inbox processed, 1 scheduled fired)
```

When the sync blocks, the output names the blocking diagnostic:

```text
dome sync: blocked — vault is in a dirty git state (mid-merge); resolve before syncing
```

Exit codes: 0 on success (including no-op success: adopted already at HEAD); 1 on blocking diagnostic or sync-time error; 2 on usage error (unknown flag, vault open failure).

### Relationship to `dome reconcile`

`dome reconcile` is preserved as a deprecated alias for `dome sync` to keep existing test fixtures, scheduled-cron entries, and harness invocations working. Invoking `dome reconcile` prints a one-line deprecation notice on stderr (`dome reconcile is deprecated; use dome sync`) and then runs `domeSync(vaultPath)`. The two commands share the underlying machinery in `src/adoption.ts`; only the user-facing name differs.

A future v1.x rewrite may retire `dome reconcile` entirely; the deprecation alias is the v0.5+phase1+phase3 migration cushion.

## `dome status`

The new CLI command. Read-only; no mutation.

```bash
cd ~/vaults/work && dome status
cd ~/vaults/work && dome status --json
```

Output (text mode):

```text
branch:   main
HEAD:     41a98c2bba39b4b1a8bcd6f9d8b2c4a3e5f6a7b8
adopted:  9c1e002dccda2a51df8e9c10a5cd8c14f5a08a2b (3 commits behind HEAD)
pending:  3 commits to adopt
dirty:    2 modified, 1 untracked
```

When adoption is uninitialized:

```text
branch:   main
HEAD:     41a98c2bba39b4b1a8bcd6f9d8b2c4a3e5f6a7b8
adopted:  (uninitialized — first `dome sync` will initialize at HEAD)
pending:  n/a
dirty:    0 modified, 0 untracked
```

When adopted has diverged:

```text
branch:   main
HEAD:     41a98c2bba39b4b1a8bcd6f9d8b2c4a3e5f6a7b8
adopted:  fa12cd9 (DIVERGED — not an ancestor of HEAD; run `dome sync --force-advance` after confirming)
pending:  n/a
dirty:    0 modified, 0 untracked
```

`--json` emits a structured object suitable for cross-tool consumption:

```json
{
  "branch": "main",
  "head": "41a98c2bba39b4b1a8bcd6f9d8b2c4a3e5f6a7b8",
  "adopted": "9c1e002dccda2a51df8e9c10a5cd8c14f5a08a2b",
  "pendingCommits": 3,
  "dirty": { "modified": 2, "untracked": 1 },
  "diverged": false
}
```

When adopted is uninitialized, the `"adopted"` field is `null` and `"pendingCommits"` is `null`. When diverged, `"diverged"` is `true`.

Exit code: 0 on success; 1 if the vault open fails; 2 on usage error. Status alone never mutates; it does not advance the adopted ref or write anything to `.dome/state/`.

## Migration from v0.5

The substrate move is small and reversible.

**On first `dome sync` against an existing v0.5 vault:**

1. The engine looks for `refs/dome/adopted/<branch>`.
2. If absent, it initializes the ref at HEAD and skips the reconcile phases (treating HEAD as already-compiled rather than as a backlog of unseen work — the v0.5 vault had `.dome/state/last-reconciled-sha.txt` carrying that role; the migration treats the v0.5 cursor as definitionally caught-up).
3. If present (the vault has already been touched by phase1+phase3 sync), normal sync proceeds.

**Existing `.dome/state/last-reconciled-sha.txt` files are tolerated:**

- The new doctor flag `--time-since-reconcile` reads the mtime of `.dome/state/last-reconcile-mtime.txt` (the renamed marker — content-irrelevant, presence + mtime are the signal) when present; falls back to `.dome/state/last-reconciled-sha.txt`'s mtime when only the legacy file exists. The migration is zero-effort: the user runs `dome sync`, the new marker is created, the old file is left in place and ignored.
- A future `dome migrate` invocation can clean up the legacy file; v0.5+phase1+phase3 does not retire it.

**Existing test fixtures continue to work:**

- The eval / test vault factories that initialize a vault and run `reconcile` produce identical results — `reconcile` is still callable through the alias, and the underlying flow is unchanged through it.
- The `tests/integration/reconcile-end-to-end.test.ts` test continues to pass; its assertions are about the reconcile phases, not the cursor-file shape.

**The .gitignore is unchanged.** `.dome/state/` is gitignored (per [[wiki/specs/vault-layout]] §"Derived operational state"); the renamed `last-reconcile-mtime.txt` lives in the same gitignored tree.

**Reverting to v0.5 is git-reset:** the adopted ref is a `refs/dome/adopted/<branch>` entry under `.git/refs/`; `git update-ref -d refs/dome/adopted/main` removes it, and the substrate falls back to the v0.5 cursor file behavior automatically. The substrate move is not invasive in either direction.

## Related

- [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]] — pins the ref's existence and meaning.
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]] — pins the four-trailer convention.
- [[wiki/specs/cli]] — `dome sync` + `dome status` shipped command surface.
- [[wiki/specs/hooks]] — commit policy (now carrying trailers) and durability story (now cursor-by-ref).
- [[wiki/specs/sdk-surface]] — the `sync` / `getAdoptionStatus` re-exports from `@dome/sdk` core.
- [[wiki/gotchas/adopted-ref-divergence]] — the divergence-and-recovery flow.
- [[wiki/matrices/event-types-and-payloads]] — `engine.adoption.advanced` + `engine.adoption.blocked`.
