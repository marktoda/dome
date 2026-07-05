---
type: invariant
created: 2026-05-27
updated: 2026-07-05
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
description: Every emitted Effect leaves an audit record (run-ledger hashes, projection/outbox rows, commit trailers); even denied effects are logged
enforced_by:
  - tests/engine/apply-effect.test.ts
  - tests/ledger/runs.test.ts
tier: shipped-default
---

# EVERY_EFFECT_IS_LEDGERED

**Tier:** Shipped default — enabled by default; disable only in tightly-resource-constrained vaults via `<vault>/.dome/config.yaml`.

**Statement:** Every Effect emitted by a Processor produces an audit record. PatchEffects that adopt are recoverable via `git log --grep="^Dome-Run:"` + the run ledger join. DiagnosticEffects, FactEffects, QuestionEffects, ExternalActionEffects, OutboxRecoveryEffects, and QuarantineRecoveryEffects land in their respective tables in `projection.db`, `outbox.db`, or operational state, keyed by `runId` (ViewEffects are captured for return to the view-phase caller and are traced via the hash list, not a durable sink). Every effect of every kind additionally contributes a hash to its run's `effect_hashes_json` fingerprint-and-count list — every emission is traceable.

This invariant replaces v0.5's `EVERY_WRITE_IS_LOGGED`. The shape generalized: the v0.5 surface was Tool effects (only the three on-disk-mutation kinds) tracked in `log.md`; v1's surface is the ten-kind effect taxonomy tracked across the run ledger, outbox, projection store, and operational recovery state, with `log.md` now a projection of the run ledger.

**Why:** Provenance — for every change Dome made, the user (or a future agent walking the audit trail) can answer: which processor produced it, against which adopted commit, with what capability use, at what cost, and what evidence (sourceRefs). Without per-effect ledgering, the audit trail has gaps; failed runs leave no trace; external-action retries are unauditable.

**Structural enforcement:**

1. **The engine applier writes each effect's content to its typed sink.** `src/engine/core/apply-effect.ts` dispatches every Effect kind, by kind, to the sink that holds its CONTENT record: `sinks.recordFact()` for FactEffects and `sinks.recordDiagnostic()` for DiagnosticEffects (both land in `projection.db`), `sinks.dispatchExternal()` for ExternalActionEffects (`outbox.db`), and adopting PatchEffects carry the run id in the commit's `Dome-Run` trailer via `commitEngineChange()`. Every sink call is keyed by `runId`, so the content record for any effect is recoverable by run.
2. **Per [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]**, the RunRecord row also carries `effect_hashes_json` — a batch fingerprint-and-count index, not a per-effect join key. The executor computes `effects.map(hashEffect)` once per run (`src/processors/executor.ts`) and `markSucceeded` persists the resulting list on the run row (`src/ledger/runs.ts`); past `EFFECT_HASHES_MAX` (100) the list is truncated to a `…+N more effect hashes` count sentinel, and `dome inspect patches` reports the true total via `effectHashCount`. These hashes are non-canonical `JSON.stringify` digests that embed each effect's sourceRef commit OID, so the same logical effect hashes differently run over run — nothing looks a hash up or verifies it against sink content. The audit record for what an effect actually did is the sink write in item 1, keyed by `runId`; the hash list only answers "how many effects, and did the set change since last run."
3. **The human-readable activity view is `dome log`**, joining engine commit trailers (and narrative commit bodies) with the run ledger on demand — the ledger DB and `dome inspect runs` are the structured audit surfaces. The once-planned `dome.log` markdown projection is retired per [[wiki/invariants/NO_ACCRETING_REGISTRIES]]; `log.md` is frozen.
4. **The engine/storage tests exercise audit landings by sink.** `tests/engine/adopt-capability-uses.test.ts` verifies capability-use ledger rows for adoption PatchEffects, `tests/engine/model-invoke.test.ts` verifies runtime capability-use audit rows, `tests/outbox/dispatch.test.ts` covers ExternalActionEffect outbox rows, and projection/answer tests cover durable projection landings.

**Counter-example:** A processor emits a `FactEffect` outside its declared `graph.write` namespace. The broker denies the effect (per [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]]); the denial itself is ledgered as a `capability_uses` row with `outcome: "denied"`. Even the rejected emission is auditable — there is no path from "processor emitted X" to "no audit record."

**Test guarantee:** `tests/invariants/every-effect-is-ledgered.test.ts` pins the invariant doc into AC3. Behavioral coverage is distributed across the engine, projection, outbox, and model-invoke tests because each effect family lands in a different sink.

**Related:**
- [[wiki/specs/run-ledger]]
- [[wiki/specs/projection-store]]
- [[wiki/specs/effects]]
- [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]
- [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]]
- [[wiki/invariants/LOG_IS_APPEND_ONLY]]
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]]
