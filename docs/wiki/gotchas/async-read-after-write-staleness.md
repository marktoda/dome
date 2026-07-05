---
type: gotcha
created: 2026-05-27
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
coverage: off-matrix
description: Queries right after adoption can miss slow garden work (LLM intake, scheduled jobs) still draining, so derived state reads stale.
enforced_at: src/engine/core/adopt.ts
enforced_at_status: deferred
first_observed: 2026-05-27
severity: low
---

# Async read-after-write staleness

**Symptom:** A user or agent commits a vault change, `dome serve`/`dome sync` starts adopting it, and a read surface queries before all follow-on operational work has drained. The query can reflect the latest adopted state while still missing slow garden work such as LLM-backed intake extraction or scheduled daily maintenance.

**Root cause:** The adoption loop runs *adoption-phase* processors synchronously against the Proposal candidate (per [[wiki/specs/processors]] §"Adoption phase — bounded, deterministic, merge-blocking"). Garden-phase processors and operational work run after adoption. The adopted ref can advance before every slow garden follow-up has produced its own sub-Proposal, projection row, outbox row, or diagnostic.

This is by design. Adoption-phase processors must be bounded and deterministic; garden-phase processors may be slow or LLM-backed (`dome.agent.ingest` calls the model; `dome.daily.create-daily` reads multiple pages). Running garden work synchronously would block every Proposal on the slowest garden processor's wall clock.

**Structural mitigation:** **explicit drain/wait surfaces for callers that need garden completion before read.**

The internal harness already has `drainOperationalWork()` for deterministic scenarios. The target public API includes `vault.drainProcessors(): Promise<void>` (per [[wiki/specs/sdk-surface]] §"Vault surface") — idempotent; awaits garden/scheduled/answer work and any in-flight outbox dispatch. That public drain surface is staged for v1.x; the current runtime close path releases SQLite handles but does not expose a complete user-facing drain API. CLI surface is also deferred to v1.x; the candidate verb is `dome wait` (or `dome status --wait-quiet`). Drain is a *synchronization* primitive, not a mutation; it doesn't fit the engine-asks model and gets its own thin verb.

Reserved use cases:

- **Test harnesses** that want to observe post-garden state deterministically. Once the drain API ships, fixture vault factories should call `drainProcessors()` between operations.
- **Interactive compiler-host flows** where the user explicitly wants to wait before handing context to another agent.
- **Cross-AI handoff via `dome export-context`** — once drain exists, the view-phase processor can call `drainProcessors()` internally to ensure projection-store reads see fresh facts.

**Specific scenarios:**

- **User commits a change; immediately calls `dome query`.** The query reads adopted state, not arbitrary working-tree edits. It sees projections produced by work that has already run, but may miss later garden additions until operational work drains.
- **User commits a raw capture; immediately queries about it.** `dome.agent.ingest` is a garden-phase processor. The raw capture can be adopted before the LLM-backed ingest sub-Proposal lands its wiki updates.
- **User runs `dome inspect diagnostics`.** The read reflects diagnostics currently in `projection.db.diagnostics`. Garden-phase diagnostics appear as those processors complete.

**Operational notes:**

- The garden/operational queue is observable through `dome inspect runs`, `dome inspect questions`, `dome inspect outbox`, and `dome status` health counts. A dedicated wait/drain CLI remains planned.
- Garden processors that fail leave failed `RunRecord` rows; the failure doesn't affect adoption (which has already completed). `dome inspect runs --status failed` surfaces them.

**Don't try to make everything synchronous.** That's a tempting fix but it pessimizes every Proposal on the slowest garden processor's latency (often LLM-backed). The async-by-default pattern is correct; the planned `drainProcessors()` surface is the right escape hatch for the rare case that needs ordering.

**Related:**
- [[wiki/specs/processors]] §"The three phases"
- [[wiki/specs/adoption]] §"The fixed-point adoption loop"
- [[wiki/specs/sdk-surface]] §"Vault surface" (`drainProcessors()`)
- [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]
- [[wiki/gotchas/processor-fixed-point-divergence]]
