---
type: invariant
created: 2026-05-27T00:00:00.000Z
updated: 2026-05-29T00:00:00.000Z
sources:
  - '[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]'
tier: axiom
---

# ENGINE_COMMITS_CARRY_DOME_TRAILERS

**Tier:** Axiom — non-disable-able.

**Statement:** Every semantic commit produced by Dome's engine during adoption
or garden patch application carries four trailers in the commit message body:

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

Init scaffolding commits are bootstrap/user-facing setup commits, not semantic
engine adoption commits, and do not carry `Dome-*` trailers.

**Structural enforcement:**

1. **Engine semantic commits use the trailer composer.** Closure commits flow
   through `src/engine/core/closure-commit.ts` and PatchEffect commits flow through
   `src/engine/core/apply-patch.ts`; both require a `runContext` and call the shared
   `composeCommitMessage` helper from `src/engine-commit.ts`.
2. **The four-trailer format is enforced by `composeCommitMessage`.** The
   function takes the `runContext` and produces the message; the trailers are
   appended after the body using `git interpret-trailers` convention.
3. **Harness scenarios assert the behavior at the git boundary.** Garden
   cascade scenarios verify patch-produced commits carry frame-correct
   trailers, and the init scenario asserts the bootstrap commit is a normal
   non-engine commit.

**Counter-example:** A future contributor adds a "fast-path" commit producer at `src/engine/quick-commit.ts` that bypasses `commitEngineChange`. The integration test fails: a commit appears in the engine-history grep without all four trailers. The test names the file path and the missing trailers; the contributor either threads `runContext` through the new path or removes the bypass.

**Test guarantee:** `tests/invariants/engine-commits-carry-dome-trailers.test.ts` pins the invariant doc into the AC3 lockstep surface. High-level harness scenarios exercise the git-boundary behavior for engine PatchEffect commits and the non-engine init bootstrap commit.

**Related:**
- [[wiki/specs/adoption]] §"Engine commit trailers"
- [[wiki/specs/run-ledger]] §"Why a separate ledger" (dual-surface)
- [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]
- [[wiki/invariants/EVERY_EFFECT_IS_LEDGERED]]
