---
type: gotcha
created: 2026-05-27
updated: 2026-05-27
severity: low
coverage: off-matrix
enforced_at: src/engine/adopt.ts
enforced_at_status: deferred
first_observed: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# Async read-after-write staleness

**Symptom:** A user submits a Proposal (via `dome submit`, a native write picked up by the watcher, or a direct `submitProposal` API call), then immediately runs a query against the vault. The query returns content that doesn't yet reflect a garden-phase processor's follow-on update (e.g., the `dome.links.cross-reference` garden processor hasn't run yet, so the newly-created entity page lacks backlinks; the `dome.intake.extract-capture` garden processor hasn't compiled the raw file into wiki updates yet).

**Root cause:** The adoption loop runs *adoption-phase* processors synchronously inside `submitProposal` (per [[wiki/specs/processors]] §"Adoption phase — bounded, deterministic, merge-blocking"). Garden-phase processors run *after* adoption completes, asynchronously (per [[wiki/specs/processors]] §"Garden phase"). The engine returns the AdoptionResult once the adopted ref advances; garden-phase work proceeds in the background.

This is by design. Adoption-phase processors must be bounded and deterministic; garden-phase processors may be slow or LLM-backed (`dome.intake.extract-capture` calls the model; `dome.daily.create-daily` reads multiple pages). Running garden work synchronously would block every Proposal on the slowest garden processor's wall clock.

**Structural mitigation:** **`drainProcessors()` opt-in for callers that need garden completion before read.**

The Vault API exposes `vault.drainProcessors(): Promise<void>` (per [[wiki/specs/sdk-surface]] §"Vault surface") — idempotent; awaits both the garden-phase queue and any in-flight outbox dispatch. CLI surface: `dome doctor --drain-processors`.

Reserved use cases:

- **Test harnesses** that want to observe post-garden state deterministically. The fixture vault factory calls `drainProcessors()` between operations.
- **Interactive `dome submit` flows** where the user explicitly wants to wait — `dome submit --wait` (proposed flag; ships with the engine's command implementation) calls `drainProcessors()` before returning.
- **Cross-AI handoff via `dome export-context`** — the view-phase processor calls `drainProcessors()` internally to ensure projection-store reads see fresh facts.

**Specific scenarios:**

- **User submits a Proposal; immediately calls `vault.query()`.** The query reads adopted state — *not* HEAD — so it sees the post-adopt projections (index, fact-extractor output from adoption-phase processors). Garden-phase additions (cross-references, capture compilations) may not yet be reflected. If the user expected those, they can re-query a few seconds later or call `drainProcessors()` first.
- **User submits a raw capture (`echo "..." > inbox/raw/today.md`); immediately queries about it.** The watcher constructs a Proposal; adoption runs; `dome.intake.extract-capture` is a *garden-phase* processor (per [[wiki/matrices/built-in-extensions-x-phase]]) and runs async. The query sees the raw file landed in `inbox/raw/`; it doesn't yet see the wiki updates the LLM is producing. The Proposal that adds wiki updates is *another* Proposal the engine constructs from the garden-emitted PatchEffect, and it goes through its own adoption loop.
- **User submits a Proposal; runs `dome doctor`.** `dome doctor`'s checks read the adopted snapshot directly; they see the post-adopt state regardless of garden completion. (Garden-phase diagnostics get added to `projection.db.diagnostics` as garden processors complete; `dome doctor --show diagnostics` updates over time.)

**Operational notes:**

- The garden-phase queue size is observable via `dome doctor --show runs --status running`. If garden processors pile up faster than they drain, the runtime may emit a `engine.queue-backpressure` event (configurable threshold). In v1's typical single-user scope, this is rare.
- Garden processors that fail leave failed `RunRecord` rows; the failure doesn't affect adoption (which has already completed). `dome doctor --show runs --status failed` surfaces them.

**Don't try to make everything synchronous.** That's a tempting fix but it pessimizes every Proposal on the slowest garden processor's latency (often LLM-backed). The async-by-default pattern is correct; `drainProcessors()` is the right escape hatch for the rare case that needs ordering.

**Related:**
- [[wiki/specs/processors]] §"The three phases"
- [[wiki/specs/adoption]] §"The fixed-point adoption loop"
- [[wiki/specs/sdk-surface]] §"Vault surface" (`drainProcessors()`)
- [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]
- [[wiki/gotchas/processor-fixed-point-divergence]]
