---
type: gotcha
created: 2026-05-27
updated: 2026-05-27
severity: medium
coverage: off-matrix
enforced_at: src/ledger/runs.ts
first_observed: 2026-05-27 (anticipated; surfaced in v1 design)
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# Run-succeeded fires before closure-commit

**Symptom:** A contributor notices that `runs.output_commit` is populated by a *separate* `UPDATE` (via `updateOutputCommit` in `src/ledger/runs.ts`, called from `src/engine/adopt.ts`) rather than as part of the `markSucceeded` `INSERT`/`UPDATE`. They reach for an apparent layering "fix": move `markSucceeded` to *after* `makeClosureCommit` returns, so the `output_commit` value is in hand at terminal-mark time. Tests in `tests/processors/runtime-ledger.test.ts` and `tests/ledger/runs.test.ts` start failing in subtle ways.

**Root cause:** Two distinct state machines coexist in the engine, and conflating them breaks the per-run lifecycle invariant.

1. **Per-run state machine** (`queued → running → succeeded | failed | skipped`). Owned by `Processor.run()`. Its terminal mark fires at the *end of the processor's unit of work* — the moment `run()` returns or throws. Pinned by [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]] §"Structural enforcement" §3: "Failed processor runs still complete the ledger row. A `try/catch` around `processor.run()` writes `status: 'failed'`, ... before rethrowing."

2. **Per-iteration adoption cycle** (`compile → run-all-processors → apply-all-effects → check-fixed-point → close → advance`). Owned by `src/engine/adopt.ts`. Its closure step (`makeClosureCommit`) fires *once per iteration*, after every processor has terminated.

These overlap in wall-clock time but are not the same machine. A run that emitted effects all of which were *rejected by the broker* (denied capability, phase-mismatch) contributed nothing to the closure commit — but the run itself absolutely reached `succeeded`. If `markSucceeded` only fired after `makeClosureCommit`, that run would be stuck in `running` forever, and `failOrphanedRuns` would eventually transition it to `failed` — a bogus failure attribution.

Symmetrically: a closure commit may never materialize (the convergence iteration had no engine-driven patches, or `vault.config.git.auto_commit_workflows` is false), in which case `makeClosureCommit` returns `null` and `output_commit` *should* stay null on every contributing run. Tying the two writes together would force a fake OID into that column or skip the terminal mark entirely.

**What to do instead:** Keep the two writes separate, as substrate ships them.

1. The runtime (`src/processors/runtime.ts`) calls `markSucceeded` with `outputCommit: null` immediately after `processor.run()` returns. This bounds the run's lifetime to the processor's unit of work.

2. The engine's adoption loop (`src/engine/adopt.ts`) accumulates the run ids that contributed to the iteration. After `makeClosureCommit` returns a non-null OID, it calls `updateOutputCommit(ledger, { runIds, outputCommit })`. The accessor filters by `status = 'succeeded' AND output_commit IS NULL` — so calling twice is a no-op, and runs that never reached `succeeded` (failed mid-flight) are untouched.

The two-write pattern is intentional. Adding a "fix" that conflates them re-introduces the orphaned-`running`-row failure mode.

**Operational notes:**

- `markSucceeded` writes `output_commit = NULL`; the column is populated by `updateOutputCommit` (defined in the same file) after the closure commit lands.
- `updateOutputCommit` uses an `IS NULL` guard on the column so a re-driven adoption cycle (e.g., the engine retries a failed close) cannot overwrite an already-landed OID with a different one.
- The dual-surface join `runs.output_commit ↔ git trailer Dome-Run` is the audit forensics surface: "what processor runs contributed to this commit?" works in both directions because both surfaces carry the same key.

**Related:**
- [[wiki/specs/run-ledger]] §"Run lifecycle" — the per-run state machine.
- [[wiki/specs/adoption]] §"The fixed-point adoption loop" §"Close" — the per-iteration cycle.
- [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]] — the structural fence the per-run machine upholds.
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]] — the other side of the dual-surface join.
- `tests/engine/adopt-output-commit.test.ts` — exercises the back-fill path end-to-end.
- `tests/ledger/runs.test.ts` §"updateOutputCommit" — unit-tests the accessor (including the re-drive defense and the not-yet-succeeded skip path).
