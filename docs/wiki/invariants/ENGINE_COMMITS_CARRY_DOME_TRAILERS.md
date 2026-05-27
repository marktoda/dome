---
type: invariant
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/delta-ledgers/2026-05-27-phase-1-3-adopted-ref-and-patch-trailers]]"]
tier: axiom
coverage: off-matrix
enforced_at: src/workflow-commit.ts
---

# ENGINE_COMMITS_CARRY_DOME_TRAILERS

**Tier:** Axiom — non-disable-able.

**Statement:** Every commit Dome's engine produces — per-workflow atomic commits today, per-sync closure commits in a future Phase 4+, future patch-mediated extension effects — carries four trailers in the commit message body:

```text
Dome-Run: run_<unix-ms>_<6-char-random>
Dome-Extension: <workflow-name-or-"engine">
Dome-Base: <adopted-sha-at-run-start>
Dome-Source-Head: <head-sha-at-run-start>
```

User out-of-band commits (vim, Obsidian, Claude Code's native `Write` → user `git commit`, etc.) do NOT carry these trailers. The structural difference is how `git log --grep="^Dome-Run:"` distinguishes engine-produced from user-produced history.

**Why:** `docs/v1.md` §4.5 names "every engine-applied patch becomes a visible Git commit" as the patch-mediated-closure win. The trailers are the structural anchor for that promise:

- **Provenance.** `git log` alone tells you which commits are engine-driven vs. user-driven, without a side-channel registry that can drift from reality.
- **Crash recovery / idempotency.** The `Dome-Run` id ties a commit to its run-time context; a future run ledger (`docs/v1.md` §16) can rejoin commits to runs via this trailer alone. The `Dome-Base` + `Dome-Source-Head` pair is the idempotency key — the same pair on a re-run signals "I did this work already against this exact source state."
- **Audit.** `git log --grep="^Dome-Extension: lint" --since="last week"` is the canonical "what did the lint workflow do this week" query. Filterable, scriptable, no parallel database needed.
- **Future-extension trust.** When Phase 4 lands `defineExtension` and third-party code, `Dome-Extension: <bundle-id>` per-commit makes "show me everything `acme.markdown_linter` touched" a one-liner.

Without the trailer convention, engine and user commits are indistinguishable in `git log`, and downstream tooling has to maintain a side-channel registry. The trailers replace the would-be registry with structural metadata living in the commit message itself.

**Structural enforcement:** Off-matrix. The trailer construction lives at `src/workflow-commit.ts` — the engine's only commit chokepoint today. `commitWorkflow` requires a `runContext: { runId, extensionId, base, sourceHead }` parameter; if the parameter is absent, the function refuses (throws) rather than producing a trailer-less engine commit. Callers (`src/workflows/agent-loop.ts`'s `runWorkflow`; future closure-pass callers in `src/adoption.ts`) construct the `RunContext` via `makeRunContext({ extensionId, base, sourceHead })`, which generates the `runId` as `run_<unix-ms>_<6-char-random>`.

The trailer line shape conforms to `git interpret-trailers` parsing: four lines after a blank separator from the commit body, each `<Key>: <value>` with the Title-Case-with-hyphens key shape git's parser recognizes. `git interpret-trailers --parse <commit-message>` round-trips the four lines.

**Counter-example (what this invariant rules out):** A future extension that writes via `vault.tools.writeDocument` and then calls `git commit` directly, bypassing `commitWorkflow`. The trailers would be absent; the commit would be indistinguishable from a user out-of-band edit; provenance would be lost. The structural fence is that `commitWorkflow` is the only function in `src/index.ts`'s engine-commit re-export set, and the runContext requirement means a caller cannot accidentally produce a trailer-less engine commit even by accident.

A second counter-example: a workflow that bypasses `commitWorkflow` entirely and produces no commit at all (just leaves working-tree changes uncommitted). The substrate's per-workflow atomic-commit policy (`docs/wiki/specs/hooks.md` §"Commit policy") gates this — the workflow runner constructs the `RunContext` and threads it; the only way to land without a commit is to set `opts.skipCommit: true` (the test-only escape hatch that explicitly disables the policy).

**Test guarantee:** `tests/invariants/engine-commits-carry-dome-trailers.test.ts` is the AC3 lockstep file. Following the off-matrix delegating-stub convention (per [[wiki/specs/sdk-surface]] §"Off-matrix lockstep convention"), it imports `tests/integration/workflow-atomic-commit.test.ts` — the canonical enforcement test, extended to assert:

- After a `writeDocument`-driving workflow, the resulting commit's message body parses with `git interpret-trailers --parse` to yield four key/value pairs.
- The keys are exactly `Dome-Run`, `Dome-Extension`, `Dome-Base`, `Dome-Source-Head`.
- The values match the expected shape:
  - `Dome-Run` matches `^run_\d+_[a-z0-9]{6}$`.
  - `Dome-Extension` equals the workflow name (`ingest` in the canonical test fixture).
  - `Dome-Base` matches `^[0-9a-f]{40}$` (or all-zeros for fresh vaults where adopted is uninitialized at run start).
  - `Dome-Source-Head` matches `^[0-9a-f]{40}$`.

**Related:**

- [[wiki/invariants/EVERY_WRITE_IS_LOGGED]] — every write is logged to `log.md`; the trailers extend the provenance story to `git log` symmetrically.
- [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]] — the adopted ref + the trailers together define the engine's git-visible footprint.
- [[wiki/specs/adoption]] — §"Engine commit trailers" is the normative shape with worked example.
- [[wiki/specs/hooks]] — §"Commit policy" names the trailer requirement at the per-workflow-commit boundary.
