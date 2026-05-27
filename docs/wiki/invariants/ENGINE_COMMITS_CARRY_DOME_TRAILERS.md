---
type: invariant
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
tier: axiom
---

# ENGINE_COMMITS_CARRY_DOME_TRAILERS

**Tier:** Axiom — non-disable-able.

**Statement:** Every commit produced by Dome's engine — closure commits from the adoption loop, garden-emitted Proposal heads, init scaffolding commits, migration commits — carries four trailers in the commit message body:

```text
Dome-Run: run_<unix-ms>_<6-char-rand>
Dome-Extension: <originating bundle id or "engine">
Dome-Base: <SHA of refs/dome/adopted/<branch> at run start>
Dome-Source-Head: <SHA of HEAD at run start>
```

User out-of-band commits (vim, Obsidian, agent's `Write`, manual `git commit`) do **not** carry these trailers. The structural difference is what makes `git log --grep="^Dome-Run:"` the canonical engine-history query and `git log --invert-grep --grep="^Dome-Run:"` the user-history query.

**Why:** Provenance is dual-surface: the run ledger (`runs.db`) is the audit-rich source; the git trailers are the durable-in-git provenance that survives clone, lives without Dome installed, and is queryable by any git tool. Joining `Dome-Run: <id>` to `runs.id` gives the full picture: which run, which processor, which capability uses, which cost, against which adopted base, with what diagnostics — for every engine commit visible in `git log`.

The dual surface also makes recovery cheap. Wiping `runs.db` and rebuilding from git trailers gives back the (status, processor, base, source-head) tuple for each successful adopted commit — losing only the failed-run history, the capability uses, and the costs. The git trailers are the *durable* surface; the ledger is the *enriched* surface.

**Structural enforcement:**

1. **`src/engine/closure-commit.ts` is the single chokepoint for engine commits.** Its `commitWorkflow(input)` function requires a `runContext` parameter; the function refuses (throws) when the parameter is absent. There is no path to producing a trailer-less engine commit through this function.
2. **`commitWorkflow` is called from exactly two places** — `src/engine/adopt.ts` (closure commits at the end of the adoption loop) and `src/engine/garden-proposal.ts` (when a garden processor's PatchEffect spawns a Proposal head). Both pass a properly-constructed `runContext`.
3. **The four-trailer format is enforced by `composeCommitMessage`.** The function takes the `runContext` and produces the message; the trailers are appended after the body using `git interpret-trailers` convention.
4. **`tests/integration/engine-commit-trailers.test.ts`** asserts every engine commit produced during a sync carries all four trailers, parseable via `git interpret-trailers --parse`.

**Counter-example:** A future Phase contributor adds a "fast-path" commit producer at `src/engine/quick-commit.ts` that bypasses `commitWorkflow`. The integration test fails: a commit appears in the engine-history grep without all four trailers. The test names the file path and the missing trailers; the contributor either threads `runContext` through the new path or removes the bypass.

**Test guarantee:** `tests/invariants/engine-commits-carry-dome-trailers.test.ts` — for each engine commit produced during a fixture sync, parses the commit message with `git interpret-trailers --parse`, asserts the four trailers are present and well-formed, asserts the `Dome-Run` value matches a row in `runs.db`.

**Related:**
- [[wiki/specs/adoption]] §"Engine commit trailers"
- [[wiki/specs/run-ledger]] §"Why a separate ledger" (dual-surface)
- [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]
- [[wiki/invariants/EVERY_EFFECT_IS_LEDGERED]]
