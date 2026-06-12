---
type: invariant
created: 2026-05-27
updated: 2026-06-11
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
enforced_by:
  - tests/engine/apply-effect.test.ts
  - tests/ledger/runs.test.ts
tier: shipped-default
---

# EVERY_EFFECT_IS_LEDGERED

**Tier:** Shipped default — enabled by default; disable only in tightly-resource-constrained vaults via `<vault>/.dome/config.yaml`.

**Statement:** Every Effect emitted by a Processor produces an audit record. PatchEffects that adopt are recoverable via `git log --grep="^Dome-Run:"` + the run ledger join. DiagnosticEffects, FactEffects, QuestionEffects, JobEffects, ExternalActionEffects, OutboxRecoveryEffects, QuarantineRecoveryEffects, and ViewEffects land in their respective tables in `projection.db`, `outbox.db`, operational state, or are part of the run ledger's effect-hashes list — every emission is traceable.

This invariant replaces v0.5's `EVERY_WRITE_IS_LOGGED`. The shape generalized: the v0.5 surface was Tool effects (only the three on-disk-mutation kinds) tracked in `log.md`; v1's surface is the eleven-kind effect taxonomy tracked across the run ledger, outbox, projection store, and operational recovery state, with `log.md` now a projection of the run ledger.

**Why:** Provenance — for every change Dome made, the user (or a future agent walking the audit trail) can answer: which processor produced it, against which adopted commit, with what capability use, at what cost, and what evidence (sourceRefs). Without per-effect ledgering, the audit trail has gaps; failed runs leave no trace; external-action retries are unauditable.

**Structural enforcement:**

1. **The engine applier writes an audit record per effect.** `src/engine/core/apply-effect.ts` calls the appropriate sink for each Effect kind: `ledger.recordEffect()` for the effect hash; `projections.facts.insert()` for FactEffects; `outbox.insert()` for ExternalActionEffects; `commitEngineChange()` carries the run id in the trailer for adopting PatchEffects.
2. **Per [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]**, the RunRecord row carries `effect_hashes_json` — a sha256 list of every emitted effect for the run. Joined back to projection tables by the per-effect lookup, the union is the complete audit history.
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
