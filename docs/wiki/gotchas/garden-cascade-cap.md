---
type: gotcha
description: "Garden patches that trigger more garden patches recurse to the cascade depth cap (10), emitting a garden.cascade-cap warning and halting."
created: 2026-05-28
updated: 2026-06-10
sources:
  - "[[v1]]"
coverage: off-matrix
enforced_at: src/engine/garden/garden.ts
first_observed: 2026-05-28 (Phase 4a' implementation)
severity: medium
---

# Garden cascade cap

**Symptom:** A garden-phase processor emits a `PatchEffect`. The engine constructs a sub-Proposal and adopts it. That sub-adoption's garden phase fires another processor which emits another PatchEffect. Repeat. Eventually the cascade depth reaches `DEFAULT_MAX_CASCADE_DEPTH` (default 10); the orchestrator emits a `garden.cascade-cap` `DiagnosticEffect` (severity `warning`) naming the depth + the count of skipped patches + the implicated processors, and does not spawn the remaining sub-Proposals. The cap-skipped patches' work is dropped; subsequent adoptions of unrelated user work proceed normally.

**Root cause:** Two or more garden-phase processors emit patches that mutually trigger each other (Processor A's patch triggers Processor B, whose patch triggers A, etc.) OR a single processor's patch re-triggers itself when the new adopted state is reached. Without the cap, the cascade would recurse indefinitely; each sub-Proposal would spawn another, depleting the system.

**Why a cascade (not fixed-point divergence):** Garden runs *after* adoption completes; sub-Proposals are full adoptions in their own right. The fixed-point divergence cap at [[wiki/gotchas/processor-fixed-point-divergence]] applies to the adoption-loop's *within-iteration* cycle; the cascade cap applies to garden's *across-Proposal* recursion. They are distinct but morally similar.

**Structural mitigation:** **Hard depth cap + diagnostic on cap-hit.**

The cap (default 10, configurable per-call via `runGardenPhase`'s `maxCascadeDepth` opt) is the structural fence. Hitting it produces a `DiagnosticEffect` with:

```text
severity: warning
code: garden.cascade-cap
message: "Garden sub-Proposal cascade hit cap=10 at depth=10;
          N PatchEffect(s) skipped. Garden processors named:
          <processor-id-1>, <processor-id-2>."
sourceRefs: []
```

The diagnostic surfaces:

- In the in-memory `GardenPhaseResult.diagnostics` (returned to the orchestrator's caller; today discarded by the compiler host, surfaced through stderr via `console.warn`).
- In `projection.db.diagnostics` via the wired `sinks.recordDiagnostic` call with `processorId: "engine.garden"` and the run id of the first queued patch.
- Operators see the diagnostic via `dome inspect diagnostics --code garden.cascade-cap`.

**Specific scenarios:**

- **Mutual triggers.** A future entity-creation intake processor emits a patch creating an entity page. `dome.links.cross-reference` reacts to the new entity by emitting a patch adding backlinks. The backlink patch re-triggers intake (because the entity now has a section structure intake re-parses). Cascade depth grows; cap fires at 10. Fix: scope intake triggers narrowly, as the shipped `dome.agent.ingest` processor does with `signal: file.created` on `inbox/raw/*.md`, not `signal: document.changed` on `wiki/entities/**`.

- **Self-trigger.** A community bundle's processor `acme.recommendations` adds suggestions to every entity page on `signal: document.changed` for `wiki/entities/**`. Each suggestion-write triggers the processor on the same path. Cap fires at 10. Fix: scope to `signal: file.created` instead of `document.changed`, or add an idempotency check (don't add suggestions if already present).

- **Long legitimate cascade.** A complex garden-LLM bundle compiles a capture into 12 wiki updates across 12 files, each triggering downstream linkers and indexers. Legitimate cascade may reach depth 5-7. The default cap of 10 is generous enough; if a legitimate workflow needs depth >10, raise the cap per-call.

**Operational notes:**

- The cap is generous (10); legitimate cascades usually reach depth 2-3. Hitting it should be considered a symptom of pathological coupling between processors, not normal operation.
- Cap-hits do NOT undo the work already adopted in the lower-depth sub-Proposals. The first N levels of the cascade succeeded; only patches that would have spawned the (N+1)-th level are dropped.
- The dropped patches are visible via the `garden.cascade-cap` diagnostic's `processorId` list; an operator can manually investigate (or, in v1.x, the `dome doctor` health-check verb may aggregate these for surface visibility).
- Authors of new garden-phase processors should run their bundle through scenarios that exercise the cascade depth to validate their trigger scope.

**Counter-example (the bad case before mitigation):** Without the cap, two mutually-triggering processors would recurse until the JS call stack exhausted or the SQLite DBs filled with audit rows. Cascade-cap surfaces the issue visibly + bounded.

**Cycle detection is depth-only in v1.0:** A content-hash-based cycle detector (track which patch contents have already been spawned at the same depth; refuse to re-spawn identical patches) would catch tight cycles in 1-2 iterations rather than 10. This is a v1.x polish; the depth cap is the v1.0 fence.

**Related:**

- [[wiki/specs/processors]] §"Garden phase"
- [[wiki/specs/proposals]] §"Garden-emitted Proposals"
- [[wiki/gotchas/processor-fixed-point-divergence]] — the within-iteration sibling pattern
- [[wiki/gotchas/processor-idempotency]] — non-idempotent processors amplify cascade risk
- [[v1]] — automation-first product plan that builds on the shipped garden substrate
