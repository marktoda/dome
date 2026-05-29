---
type: spec
created: 2026-05-27T00:00:00.000Z
updated: 2026-05-29T00:00:00.000Z
sources:
  - '[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]'
  - '[[v1]]'
---

# Adoption

This spec is normative for Dome's adoption substrate — the `refs/dome/adopted/<branch>` ref, the **fixed-point adoption loop**, the Dome-* trailer convention on engine commits, and the CLI commands (`dome sync`, `dome status`) that surface adoption to consumers.

Adoption is the heart of the engine model. Every write — human, agent, garden, scheduled — flows through it. The loop is what makes the vault self-coherent.

## The adopted ref

`refs/dome/adopted/<branch>` is the canonical "trusted semantic state" cursor for the named source branch. It points to the latest commit Dome has fully adopted. The engine advances it only after a Proposal's adoption loop reaches a clean fixed point.

```text
refs/heads/main                  user/client/agent source branch
refs/dome/adopted/main           latest fully adopted semantic state for `main`
```

One ref per source branch. Fast-forward-only advance: if HEAD's ancestry no longer contains the current adopted commit (force-push, hard-reset, rebase), `dome sync` refuses. The intended v1.1 recovery is `dome sync --force-advance` after confirming the rewritten HEAD; in v1.0 the operator resolves manually. See [[wiki/gotchas/adopted-ref-divergence]].

Pinned by [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]].

## The fixed-point adoption loop

```text
proposal P arrives with base = adopted, head = candidate

candidate := merge(adopted, P.head)

for iteration in 1..MAX_ITER:
  snapshot      := read(candidate)
  changedPaths  := compileRange(base = P.base, head = candidate)
  signals       := signalsFor(changedPaths, snapshot)

  effects := []
  for each processor P in adoption-phase processors whose triggers match signals:
    runRecord := ledger.beginRun(P, snapshot, signals)
    procEffects := P.run({ snapshot, changedPaths, proposal: P, ... })
    ledger.completeRun(runRecord, procEffects)
    effects.push(...procEffects)

  diagnostics := effects.filter(isBlockingDiagnostic)
  if diagnostics.length > 0:
    emit engine.adoption.blocked { proposal, diagnostics }
    return { adopted: false, diagnostics, iterations: iteration }

  patches := effects.filter(isAutoPatchAfterCapabilityEnforcement)
  if patches.length == 0:
    break  # fixed point reached

  candidate := applyPatches(candidate, patches)

if iteration == MAX_ITER:
  emit engine.adoption.blocked { proposal, diagnostics: [{ severity: "block", code: "fixed-point.divergence", ... }] }
  return { adopted: false, ... }

# Close: if the loop produced engine-driven changes, the candidate chain head
# is the closure commit OID surfaced to callers
if candidate != P.head:
  closureCommit := candidate
else:
  closureCommit := null

# Adopt: atomically advance the adopted ref
setAdoptedRef(branch, candidate)
emit engine.adoption.advanced { proposal, closureCommit, iterations }
return { adopted: true, adoptedRef: candidate, closureCommit, iterations }
```

The loop has six properties that make it well-behaved:

1. **Bounded.** `MAX_ITER` (default 100, configurable as `engine.max_iterations` in `.dome/config.yaml`) caps wall-clock cost. Hitting the cap is a blocking diagnostic, not an infinite loop.
2. **Deterministic.** Adoption-phase processors are pure (snapshot in, effects out) and idempotent. The same Proposal against the same processor set converges to the same fixed point.
3. **Atomic.** The adopted ref advances exactly once per Proposal, at the end. Mid-loop crashes leave the ref unchanged.
4. **Capability-checked.** Every effect passes through `enforceCapability` before being applied. PatchEffects exceeding `patch.auto` grants are downgraded to `propose` and emit a [[wiki/gotchas/capability-downgrade-surprise]] diagnostic; in adoption, any proposed patch blocks the loop for human review instead of being silently applied.
5. **Ledgered.** Every processor invocation writes a `RunRecord` row, regardless of outcome. Failed adoptions are debuggable.
6. **Closure-explicit.** Engine-driven changes land as git commits carrying the four Dome-* trailers. In the current plumbing path, each auto PatchEffect writes one candidate commit and the final candidate chain head is surfaced as `closureCommitOid`; a future squash/compaction layer may make that a single commit without changing the adoption result contract. The trailers are the durable provenance surface in `git log`.

Pinned by [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]], [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]], [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]].

### MAX_ITER and divergence

The cap exists for catastrophic runaway, not as the primary mechanism. A well-formed adoption phase converges in 1–3 iterations:

- Iteration 1: processors emit patches (e.g., wikilink-resolver inserts missing path prefixes; index-updater adds the new entry).
- Iteration 2: processors run against the patched tree; emit no new patches; fixed point reached.

A divergent adoption (rare) means a processor's emitted patch invalidates a property a *different* processor reacts to, which patches it back, etc. The cap catches this; the diagnostic names both processors involved. See [[wiki/gotchas/processor-fixed-point-divergence]].

The default cap of 100 is generous — legitimate fan-out across an entity-rich vault may reach depths of 10–20. Values below 30 risk false positives on shipped-default processor sets.

## Compile range

`compileRange(base, head)` is the engine's primitive for "what changed in this Proposal." It produces:

```ts
interface CompileRangeResult {
  readonly changedPaths: ReadonlyArray<string>;
  readonly addedPaths: ReadonlyArray<string>;
  readonly modifiedPaths: ReadonlyArray<string>;
  readonly deletedPaths: ReadonlyArray<string>;
  readonly signals: ReadonlyArray<Signal>;
}
```

Signals are synthesized from the diff: `file.created` for added paths, `file.modified` for modified, `file.deleted` for deleted; `document.changed` for any markdown file change; `frontmatter.changed` when frontmatter delta is non-empty; `region.changed` when a marker-delimited region's content changed; `link.added` / `link.removed` when wikilinks in the body change.

The result is computed once per loop iteration and passed to every processor whose triggers match. Processors don't re-walk the diff; the engine does it once.

## Engine commit trailers

Every semantic engine-produced commit from adoption or garden patch application
carries four trailers in the message body:

```text
adopt: <Proposal source kind> proposal <Proposal id-prefix>

Dome-Run: run_1748313600000_a3f9b2
Dome-Extension: <originating bundle id or "engine">
Dome-Base: 9c1e002dccda2a51df8e9c10a5cd8c14f5a08a2b
Dome-Source-Head: 41a98c2bba39b4b1a8bcd6f9d8b2c4a3e5f6a7b8
```

Trailers sit after a blank line per `git interpret-trailers` convention. They are structurally parseable.

| Trailer | Value |
|---|---|
| `Dome-Run` | Run id of the form `run_<unix-ms>_<6-char-rand>`. Matches the RunRecord's `id`. |
| `Dome-Extension` | The bundle id that originated the work (`dome.intake`, `dome.daily`, etc.). For pure engine closure (capability downgrade, schema autoformat), the value is `engine`. |
| `Dome-Base` | SHA of `refs/dome/adopted/<branch>` at the moment the loop started. All-zeros (`0000000000000000000000000000000000000000`) when adopted was uninitialized. |
| `Dome-Source-Head` | SHA of HEAD at the moment the loop started. |

User out-of-band commits (vim, Obsidian, agent's `Write`) do **not** carry these trailers. The structural difference makes `git log --grep="^Dome-Run:"` the canonical engine-history query and `git log --invert-grep --grep="^Dome-Run:"` the user-history query.

`dome init`'s initial scaffold commit is a bootstrap setup commit, not an
adoption/garden semantic engine commit, and intentionally does not carry
`Dome-*` trailers.

Pinned by [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]]. The trailers and the run ledger are dual surfaces for the same provenance — see [[wiki/specs/run-ledger]] §"Why a separate ledger".

## User-facing adoption entrypoints

In v1.0 the user-facing write contract is Git-native. Users and harnesses write markdown, create normal git commits on the source branch, then either let `dome serve` observe the branch ref or run `dome sync` to block on adoption. There is no public `dome submit` command and no public SDK `submitProposal` API in v1.0.

The retired `dome submit` shape existed in earlier drafts as a direct Proposal-construction command, including patch submission. It was removed because it created a second external write vocabulary beside plain git. The engine still constructs Proposals internally; the public boundary is `git commit` plus `dome sync` / `dome serve`.

## `dome sync`

`dome sync` is the explicit catch-up command. It constructs a Proposal from `adopted..HEAD` (or runs an empty-diff init when the adopted ref is uninitialized) and runs it through the adoption loop. Use it when:
- The user accumulated working-tree commits manually and wants the engine to catch up.
- The daemon (`dome serve`) was off and missed events; `dome sync` reconciles.
- A scheduled processor's cron interval elapsed and the engine wasn't running (v1.1).

```bash
cd ~/vaults/work && dome sync
cd ~/vaults/work && dome sync --json
cd ~/vaults/work && dome sync --force-advance  # accept divergent HEAD (v1.1 — see below)
```

`dome sync` is semantically the same per-tick body `dome serve` runs in its poll loop, invoked exactly once and surfaced with a CLI exit code. Drift detection + adoption invocation are shared between the two commands through the engine compiler host (`src/engine/compiler-host.ts`). The shared tick acquires a branch-level compiler-host lock before adoption or operational patch work, so `sync`, `serve`, and future host surfaces do not run the same branch concurrently.

The four outcomes:

- **adopted** — adoption succeeded; the adopted ref advanced to HEAD. Exit 0.
- **blocked** — adoption ran but block-severity diagnostics prevented the adopted ref from advancing. Exit 1; stderr lists the first five blockers.
- **in-sync** — HEAD already equals the adopted ref; no work done. Exit 0.
- **busy** — another compiler host holds the branch lock. Exit 75 (EX_TEMPFAIL); retry after that host finishes.
- **error** — detached HEAD or no commits; the adopted-ref substrate cannot operate. Exit 64 (EX_USAGE).

Output (text mode):

```text
dome sync: adopted main: 9c1e002..41a98c2 (0 diagnostics, 1 iteration)
```

Output (`--json`):

```json
{"status":"adopted","branch":"main","base":"9c1e002...","head":"41a98c2...","adoptedRef":"41a98c2...","iterations":1,"closureCommit":null,"diagnostics":[]}
```

Garden-phase and view-phase scheduled-trigger processors run after a successful top-level adoption attempt. Scheduled garden PatchEffects must re-enter adoption as garden sub-Proposals; they do not mutate the adopted candidate directly.

The `--force-advance` flag is **designed-for, not shipped in v1.0**. The adopted-ref's fast-forward-only check is in place via `setAdoptedRef`, but the user-facing bypass lands with the adopted-ref-divergence recovery flow in v1.1. Until then, a divergent HEAD surfaces as a blocking diagnostic and the operator resolves manually (e.g., `git reset --hard <adopted-ref>` to realign).

The CLI `dome reconcile` shipped in v0.5+phase1+phase3 as a deprecated alias for `dome sync`. **The alias is retired in v1.** Callers that still invoke `dome reconcile` see "unknown command" and a one-line pointer to `dome sync`.

## `dome status`

Read-only adoption snapshot. No mutation.

```bash
cd ~/vaults/work && dome status
cd ~/vaults/work && dome status --json
```

Output (text mode):

```text
branch:    main
HEAD:      41a98c2bba39b4b1a8bcd6f9d8b2c4a3e5f6a7b8
adopted:   9c1e002dccda2a51df8e9c10a5cd8c14f5a08a2b (3 commits behind HEAD)
pending:   3 commits to adopt
dirty:     2 modified, 1 untracked
last sync: 4 hours ago
processors: 47 loaded across 9 bundles
ledger:    13,847 runs (last 30d: 412)
outbox:    2 pending, 0 failed
```

When adoption is uninitialized:

```text
branch:    main
HEAD:      41a98c2bba39b4b1a8bcd6f9d8b2c4a3e5f6a7b8
adopted:   (uninitialized — first `dome sync` will initialize at HEAD)
pending:   n/a
...
```

`--json` emits a structured object suitable for cross-tool consumption.

Exit code: 0 on success; 1 if vault open fails; 2 on usage error.

## Hosted-protected mode (v1.5 — designed-for, not shipped in v1)

The adopted-ref shape accommodates a hosted-multi-client mode without further design work:

```text
# Local-eventual (v1 default):
refs/heads/main                       # user/client/agent source
refs/dome/adopted/main                # adopted cursor

# Hosted-protected (v1.5):
refs/heads/main                       # adopted trunk (the "PR target")
refs/heads/proposals/<PR-number>      # PR head; the engine runs adoption against this
```

In hosted mode, a `PR opened` webhook constructs a Proposal with `id = <PR number>`, `base = refs/heads/main`, `head = <PR head>`. The adoption loop runs in CI; engine closure commits land on the PR branch via push; the PR auto-merges into `main` on a clean fixed point or routes to review based on capability policy.

The local-eventual and hosted-protected modes are conceptually the same loop:

| Aspect | Local-eventual | Hosted-protected |
|---|---|---|
| Adopted cursor | `refs/dome/adopted/<branch>` | `refs/heads/main` |
| Proposal head | working-tree HEAD | PR head commit |
| Loop runs | locally in `dome sync` / `dome serve` | in CI on PR events |
| Closure commits | land on user branch | land on PR branch |
| Adoption | local ref advance | PR auto-merge |

The local-eventual flow is what v1 ships. The hosted-protected flow ships in v1.5 — at which point a vault can run either mode (controlled by `vault.mode: "local" | "hosted"` in `.dome/config.yaml`).

## Migration from v0.5+phase1+phase3

The adopted-ref + Dome-* trailer machinery landed in v0.5 (per the prior `2026-05-27-phase-1-3-adopted-ref-and-patch-trailers` ledger). The v1 engine model preserves both — the ref shape, the trailer shape, the fast-forward-only advance rule, the divergence-recovery flow.

What changes in v1:
- The reconcile machinery (three-phase inbox/diff/scheduled) dissolves into adoption-phase + scheduled-trigger processors. The same work happens; it happens through the processor runtime instead of a separate function.
- The closure step is no longer a no-op (in v0.5 it was a no-op because per-workflow atomic commits made closure unnecessary). In v1, the fixed-point loop's accumulated patches advance the candidate via engine-produced commits; the final chain head is the Proposal's closure OID.
- Garden-emitted Proposals (a new concept in v1) re-enter the adoption loop instead of writing directly via the engine-commit chokepoint.

The migration is non-invasive:
- Existing `refs/dome/adopted/<branch>` values are preserved.
- Existing engine commits already carry the four trailers; v1 reads them.
- The `dome serve --hosted` flag is the v1.5 entry; v1 ships only `dome serve` (local mode).

`dome reconcile`'s deprecation alias is retired in v1 — callers must update to `dome sync`. The alias was a v0.5+phase1+phase3 migration cushion; one minor release of cushion is enough.

## Related

- [[wiki/specs/proposals]] — the loop's input
- [[wiki/specs/processors]] — what runs inside the loop
- [[wiki/specs/effects]] — what processors emit
- [[wiki/specs/capabilities]] — how effects are gated
- [[wiki/specs/projection-store]] — where non-patch effects land
- [[wiki/specs/run-ledger]] — RunRecord per processor invocation
- [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]] — ref existence + meaning
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]] — provenance trailers
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]] — applier chokepoint
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] — write-path chokepoint
- [[wiki/gotchas/adopted-ref-divergence]] — divergence-and-recovery flow
- [[wiki/gotchas/processor-fixed-point-divergence]] — MAX_ITER cap-hit recovery
- [[wiki/gotchas/dirty-git-state-at-reconcile]] — adoption refuses on dirty state
- [[wiki/matrices/effect-router-targets]] — per-effect-kind routing
