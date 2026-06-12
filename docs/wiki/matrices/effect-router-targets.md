---
type: matrix
created: 2026-05-27
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
description: Crosses Effect kind with processor phase to give each pair's engine routing destination, including which pairs reject as phase-mismatch.
---

# Effect router targets

The canonical mapping from Effect kind × processor phase → engine routing destination. Adoption, view, and non-patch garden effects route through `src/engine/core/apply-effect.ts`; garden PatchEffects route through `src/engine/garden/garden-patch-dispatch.ts` because their target is sub-Proposal construction rather than an inline sink. This matrix enumerates the destinations per (kind, phase) pair, and what happens when the pair is incompatible.

## The matrix

| Effect kind | Adoption phase | Garden phase | View phase |
|---|---|---|---|
| **PatchEffect (mode: "auto")** | Applied to candidate tree; loop re-iterates | Spawns new Proposal via [[wiki/specs/proposals]] §"Garden-emitted Proposals"; routed through adoption | Rejected: `phase-mismatch` diagnostic |
| **PatchEffect (mode: "propose")** | Blocks adoption with diagnostic naming patch; review/apply surface is planned and not shipped as a dedicated CLI yet | v1.0: recorded as an allowed `patch.propose` capability use, diagnosed as `garden.patch-propose-review-unavailable`, and dropped until the garden review surface exists. v1.x: route to PR/review queue rather than apply inline. | Rejected: `phase-mismatch` diagnostic |
| **DiagnosticEffect (severity: "block")** | Blocks adoption; emits `engine.adoption.blocked` | Recorded in `projection.db.diagnostics` as severity `error` (garden can't block adoption — it ran *after*); surfaced via `dome check` and advanced `dome inspect diagnostics` | Rejected: `phase-mismatch` — view processors have no merge gate; block-severity from view phase is a programming error, surfaced as a diagnostic naming the offending processor. |
| **DiagnosticEffect (severity: "error" \| "warning" \| "info")** | Recorded in `projection.db.diagnostics`; non-blocking | Same | Same |
| **FactEffect** | Recorded in `projection.db.facts` (namespace-scoped per `graph.write` capability) | Same | Rejected: `phase-mismatch` diagnostic (view-phase processors don't extract facts) |
| **SearchDocumentEffect** | Upserts/deletes `projection.db.fts_documents` rows (path-scoped per `search.write` capability) | Same | Rejected: `phase-mismatch` diagnostic (view-phase processors query search; they do not mutate it) |
| **QuestionEffect** | Recorded in `projection.db.questions`; surfaced via `dome check` and advanced `dome inspect questions`; resolved via `dome resolve <question-id>` (`dome answer` remains a compatibility alias) per [[wiki/specs/cli]] §"`dome resolve`" | Same | Rejected: `phase-mismatch` diagnostic |
| **JobEffect** | Rejected: adoption-phase processors can't enqueue follow-on work (would re-trigger inside same loop iteration) | Enqueued in `projection.db.scheduled_jobs`; runs after `runAfter?` elapses or immediately if absent | Rejected: `phase-mismatch` diagnostic |
| **ExternalActionEffect** | Rejected: adoption-phase processors can't touch the outside world (would race with the merge gate) | Inserted into `outbox.db`; dispatched to the registered external handler; status tracked per [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]] | Rejected: `phase-mismatch` diagnostic |
| **OutboxRecoveryEffect** | Rejected: adoption-phase processors cannot recover operational rows before adoption is settled | Applies an engine-owned outbox recovery transition (`retry` or `abandon`) after `outbox.recover` capability enforcement | Rejected: `phase-mismatch` diagnostic |
| **QuarantineRecoveryEffect** | Rejected: adoption-phase processors cannot recover operational rows before adoption is settled | Applies an engine-owned quarantine-generation recovery transition (`reset`) after `quarantine.recover` capability enforcement | Rejected: `phase-mismatch` diagnostic |
| **RunRecoveryEffect** | Rejected: adoption-phase processors cannot recover operational rows before adoption is settled | Applies an engine-owned run-ledger recovery transition (`fail`) after `run.recover` capability enforcement | Rejected: `phase-mismatch` diagnostic |
| **ViewEffect** | Rejected: adoption-phase processors don't render views | Rejected: garden-phase processors don't render views (run async, no caller waiting) | Returned to the caller (CLI command, MCP `dome.run_command`, future HTTP request) |

## Phase-mismatch diagnostic shape

When a processor emits an Effect incompatible with its phase, the engine writes a `DiagnosticEffect` against the processor's RunRecord:

```text
severity: "error"
code: "phase-mismatch"
message: "Processor <id> (phase=<phase>) emitted <effect-kind>; this combination is not routed."
```

The original effect is **discarded** (not applied, not recorded in its expected sink). This is a routing outcome, not a processor execution failure: if `Processor.run()` returned a valid `Effect[]`, the run lifecycle can still be `succeeded` while the router reports a diagnostic for the rejected effect.

This catches bugs in processor authoring — a processor declared `phase: "view"` that emits a `PatchEffect` (likely a copy-paste error or a phase mis-declaration) fails loudly on the first invocation.

## Phase compatibility precedes capability enforcement

The routing chokepoint first rejects incompatible `(effect kind, phase)` pairs with `phase-mismatch`. The rejected effect is not applied, not recorded in its expected sink, not broker-checked, and not capability-use-ledgered; its audit record is the phase-mismatch diagnostic on the processor RunRecord.

Every phase-compatible effect is then capability-checked before any sink write, sub-Proposal route, or view return. An effect that fails capability enforcement (per [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]]) is either:

- **Denied:** discarded with a capability-deny diagnostic (recorded in `capability_uses` with `outcome: "denied"`).
- **Downgraded:** routed under the downgraded shape (e.g., PatchEffect `auto → propose`).

So an unauthorized auto-patch with complete `patch.propose` coverage goes to the propose route, not the deny route. In adoption, that route is `blocked-for-review` with a `patch.propose.requires-review` diagnostic; in garden v1.0 it is diagnosed and dropped because the review queue is not yet wired. See [[wiki/gotchas/capability-downgrade-surprise]].

## Engine commit surface

PatchEffects with `mode: "auto"` advance the candidate tree across loop iterations. In the current plumbing implementation, each successful auto PatchEffect writes one engine commit with the four Dome-* trailers per [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]], and the adoption result reports the final candidate chain head as `closureCommitOid`.

The contract callers rely on is the final closure OID and trailer-bearing engine history. A future compaction/squash layer can reduce multi-patch chains to one human-facing commit without changing the effect-routing matrix.

## Why this matrix is closed

Three properties hold:

1. **Every (kind, phase) pair has one route.** No ambiguity in routing means no defensive code in `apply-effect.ts`.
2. **Phase-mismatch is structurally caught.** The matrix specifies which pairs are valid; the engine rejects the rest at the routing chokepoint.
3. **Phase compatibility and capability enforcement are separate gates.** The router rejects structurally impossible phase/effect pairs; the broker authorizes every phase-compatible effect before it can reach a sink or sub-Proposal route.

## Related

- [[wiki/specs/effects]] — the eleven kinds
- [[wiki/specs/processors]] — phase semantics
- [[wiki/specs/adoption]] — the fixed-point loop
- [[wiki/specs/projection-store]] — where Facts / Diagnostics / Questions / Jobs land
- [[wiki/specs/run-ledger]] — where every routed effect is hashed into the RunRecord
- [[wiki/matrices/effect-x-capability]] — what each kind requires capability-wise (upstream of routing)
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]]
