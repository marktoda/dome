---
type: invariant
created: 2026-05-27
updated: 2026-05-29
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
tier: shipped-default
---

# EVERY_EFFECT_IS_LEDGERED

**Tier:** Shipped default — enabled by default; disable only in tightly-resource-constrained vaults via `<vault>/.dome/config.yaml`.

**Statement:** Every Effect emitted by a Processor produces an audit record. PatchEffects that adopt are recoverable via `git log --grep="^Dome-Run:"` + the run ledger join. DiagnosticEffects, FactEffects, QuestionEffects, JobEffects, ExternalActionEffects, OutboxRecoveryEffects, QuarantineRecoveryEffects, and ViewEffects land in their respective tables in `projection.db`, `outbox.db`, operational state, or are part of the run ledger's effect-hashes list — every emission is traceable.

This invariant replaces v0.5's `EVERY_WRITE_IS_LOGGED`. The shape generalized: the v0.5 surface was Tool effects (only the three on-disk-mutation kinds) tracked in `log.md`; v1's surface is the eleven-kind effect taxonomy tracked across the run ledger, outbox, projection store, and operational recovery state, with `log.md` now a projection of the run ledger.

**Why:** Provenance — for every change Dome made, the user (or a future agent walking the audit trail) can answer: which processor produced it, against which adopted commit, with what capability use, at what cost, and what evidence (sourceRefs). Without per-effect ledgering, the audit trail has gaps; failed runs leave no trace; external-action retries are unauditable.

**Structural enforcement:**

1. **The engine applier writes an audit record per effect.** `src/engine/apply-effect.ts` calls the appropriate sink for each Effect kind: `ledger.recordEffect()` for the effect hash; `projections.facts.insert()` for FactEffects; `outbox.insert()` for ExternalActionEffects; `commitWorkflow()` carries the run id in the trailer for adopting PatchEffects.
2. **Per [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]**, the RunRecord row carries `effect_hashes_json` — a sha256 list of every emitted effect for the run. Joined back to projection tables by the per-effect lookup, the union is the complete audit history.
3. **`log.md` is a projection of the run ledger** reserved for the planned `dome.log` adoption-phase processor. The user-facing `log.md` view should be reconstructable from `runs.db` + `outbox.db` once that bundle ships; today the ledger DB and `dome inspect runs` are the implemented audit surfaces.
4. **The integration test exercises every Effect kind's audit landing.** `tests/integration/effect-ledger-completeness.test.ts` runs each Effect kind against the engine and asserts the audit record reaches its expected sink.

**Counter-example:** A processor emits a `FactEffect` outside its declared `graph.write` namespace. The broker denies the effect (per [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]]); the denial itself is ledgered as a `capability_uses` row with `outcome: "denied"`. Even the rejected emission is auditable — there is no path from "processor emitted X" to "no audit record."

**Test guarantee:** `tests/invariants/every-effect-is-ledgered.test.ts` — fires 100 effects of mixed kinds through the engine; asserts every effect lands in its expected sink (ledger row, projection table, outbox, or rejection record).

**Related:**
- [[wiki/specs/run-ledger]]
- [[wiki/specs/projection-store]]
- [[wiki/specs/effects]]
- [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]
- [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]]
- [[wiki/invariants/LOG_IS_APPEND_ONLY]]
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]]
