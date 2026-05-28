---
type: matrix
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# Effect router targets

The canonical mapping from Effect kind × processor phase → engine routing destination. Every Effect a Processor returns is routed by `src/engine/apply-effect.ts`; this matrix enumerates the destinations per (kind, phase) pair, and what happens when the pair is incompatible.

## The matrix

| Effect kind | Adoption phase | Garden phase | View phase |
|---|---|---|---|
| **PatchEffect (mode: "auto")** | Applied to candidate tree; loop re-iterates | Spawns new Proposal via [[wiki/specs/proposals]] §"Garden-emitted Proposals"; routed through adoption | Rejected: `phase-mismatch` diagnostic |
| **PatchEffect (mode: "propose")** | Blocks adoption with diagnostic naming patch; user reviews via `dome lint --apply` | Spawns new Proposal as `source: { kind: "garden", ... }` with metadata.reason = patch.reason; goes to user via PR (hosted) or review queue (local) | Rejected: `phase-mismatch` diagnostic |
| **DiagnosticEffect (severity: "block")** | Blocks adoption; emits `engine.adoption.blocked` | Recorded in `projection.db.diagnostics` as severity `error` (garden can't block adoption — it ran *after*); surfaced via `dome inspect diagnostics` | Rejected: `phase-mismatch` — view processors have no merge gate; block-severity from view phase is a programming error, surfaced as a diagnostic naming the offending processor. |
| **DiagnosticEffect (severity: "error" \| "warning" \| "info")** | Recorded in `projection.db.diagnostics`; non-blocking | Same | Same |
| **FactEffect** | Recorded in `projection.db.facts` (namespace-scoped per `graph.write` capability) | Same | Rejected: `phase-mismatch` diagnostic (view-phase processors don't extract facts) |
| **QuestionEffect** | Recorded in `projection.db.questions`; surfaced via `dome inspect questions` and `dome query --questions`; resolved via `dome answer <question-id>` per [[wiki/specs/cli]] §"dome answer" | Same | Rejected: `phase-mismatch` diagnostic |
| **JobEffect** | Rejected: adoption-phase processors can't enqueue follow-on work (would re-trigger inside same loop iteration) | Enqueued in `projection.db.scheduled_jobs`; runs after `runAfter?` elapses or immediately if absent | Rejected: `phase-mismatch` diagnostic |
| **ExternalActionEffect** | Rejected: adoption-phase processors can't touch the outside world (would race with the merge gate) | Inserted into `outbox.db`; dispatched to the registered external handler; status tracked per [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]] | Rejected: `phase-mismatch` diagnostic |
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

## Capability enforcement is upstream

Routing happens *after* capability enforcement. An effect that fails capability enforcement (per [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]]) is either:

- **Denied:** discarded with a capability-deny diagnostic (recorded in `capability_uses` with `outcome: "denied"`).
- **Downgraded:** routed under the downgraded shape (e.g., PatchEffect `auto → propose`).

So an unauthorized auto-patch goes to the propose route, not the deny route. In adoption, that route is `blocked-for-review` with a `patch.propose.requires-review` diagnostic; see [[wiki/gotchas/capability-downgrade-surprise]].

## Engine commit surface

PatchEffects with `mode: "auto"` advance the candidate tree across loop iterations. In the current plumbing implementation, each successful auto PatchEffect writes one engine commit with the four Dome-* trailers per [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]], and the adoption result reports the final candidate chain head as `closureCommitOid`.

The contract callers rely on is the final closure OID and trailer-bearing engine history. A future compaction/squash layer can reduce multi-patch chains to one human-facing commit without changing the effect-routing matrix.

## Why this matrix is closed

Three properties hold:

1. **Every (kind, phase) pair has one route.** No ambiguity in routing means no defensive code in `apply-effect.ts`.
2. **Phase-mismatch is structurally caught.** The matrix specifies which pairs are valid; the engine rejects the rest at the routing chokepoint.
3. **Capability enforcement is one layer above routing.** Routing assumes capabilities have been checked; the broker assumes effects are well-formed. Separation of concerns at the engine boundary.

## Related

- [[wiki/specs/effects]] — the seven kinds
- [[wiki/specs/processors]] — phase semantics
- [[wiki/specs/adoption]] — the fixed-point loop
- [[wiki/specs/projection-store]] — where Facts / Diagnostics / Questions / Jobs land
- [[wiki/specs/run-ledger]] — where every routed effect is hashed into the RunRecord
- [[wiki/matrices/effect-x-capability]] — what each kind requires capability-wise (upstream of routing)
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]]
