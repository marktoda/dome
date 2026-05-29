---
type: invariant
created: 2026-05-27
updated: 2026-05-28
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
tier: shipped-default
---

# EVERY_PROCESSOR_RUN_IS_LEDGERED

**Tier:** Shipped default — enabled by default; disable in `.dome/config.yaml` only for tightly-resource-constrained vaults.

**Statement:** Every Processor invocation, regardless of phase (adoption / garden / view) or outcome (succeeded / failed / skipped / timed_out / cancelled), writes one `RunRecord` row to the run ledger (`<vault>/.dome/state/runs.db`). The row captures `runId`, `processorId`, `processorVersion`, `phase`, `proposalId?`, `inputCommit`, `outputCommit?`, `status`, `effectHashes`, `capabilityUses`, `cost?`, `error?`, `startedAt`, `finishedAt?`.

**Why:** The ledger is the audit surface for "what did Dome do." Without it, failed processor invocations leave no trace (git only records successful commits), cost tracking is impossible, and capability use is unauditable. The ledger is also the join surface for engine commit trailers (`Dome-Run` matches `runs.id`) — the dual-surface enforcement of provenance.

**Structural enforcement:**

1. **The engine begins a RunRecord on every processor dispatch.** `src/processors/runtime.ts` calls `insertQueued` (via `src/ledger/runs.ts`) before execution-policy resolution. If the runtime does not invoke the processor, it writes `markSkipped` with an optional structured reason. If the processor is invoked, it transitions through `markRunning` and then writes exactly one executor-result terminal mark: `markSucceeded`, `markFailed`, `markTimedOut`, or `markCancelled`.
2. **The applier/runtime writes `capability_uses` rows per privileged reach.** Effect routing records broker decisions, and runtime-only powers such as `model.invoke` record context-boundary decisions. Joined to the RunRecord by `run_id`.
3. **Failed, timed-out, and cancelled processor runs still complete the ledger row.** The executor boundary converts thrown processors, invalid output, timeouts, cancellations, and nominal `ctx.modelInvoke` failures into structured terminal results. The runtime persists those results as `status: 'failed'`, `status: 'timed_out'`, or `status: 'cancelled'` with structured `processor.threw`, `processor.invalid-output`, `processor.timeout`, `processor.cancelled`, or runtime-created `model.invoke.*` / `model.output.*` errors. These outcomes are durably observable.
4. **Orphan runs are detected.** Engine crashes between `status: 'running'` and the terminal update leave rows with `status: 'running'` and no `finished_at`. `dome inspect runs --status running` lists them. Recovery follows the engine-asks model (v1.x): the deferred `dome.health.detect-orphan-runs` scheduled garden-phase processor emits a `QuestionEffect` per orphan row; the user answers `dome answer <question-id> fail` (transition to `failed`) or `keep` (still legitimately running); the answer-handler processor applies the mutation.

**Counter-example:** A processor that wants to "log to its own file" instead of the ledger. The ledger row gets written anyway (by the engine, before execution policy is resolved and before `run()` is called) — the processor's parallel logging is duplicate effort. If the processor crashes mid-run, the executor-result terminal write guarantees the ledger row reaches a terminal status, even though the processor's own log file may be incomplete.

**Test guarantee:** `tests/invariants/every-processor-run-is-ledgered.test.ts` is the AC3 lockstep marker that keeps this invariant document present at the canonical path. Behavioral coverage lives in the runtime, ledger, executor, scheduler, and lifecycle tests: those assert terminal status persistence, structured executor errors, skipped not-invoked rows, capability-use joins, and adoption blocking on failed processor execution.

**Related:**
- [[wiki/specs/run-ledger]]
- [[wiki/specs/processors]]
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]] — dual provenance surface
- [[wiki/invariants/EVERY_EFFECT_IS_LEDGERED]]
- [[wiki/invariants/LOG_IS_APPEND_ONLY]] — log.md is a projection of the ledger
