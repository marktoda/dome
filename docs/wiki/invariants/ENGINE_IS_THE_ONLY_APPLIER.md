---
type: invariant
created: 2026-05-27
updated: 2026-06-10
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
enforced_by:
  - tests/integration/no-direct-mutation-outside-boundaries.test.ts
  - tests/engine/apply-effect.test.ts
tier: axiom
---

# ENGINE_IS_THE_ONLY_APPLIER

**Tier:** Axiom — non-disable-able.

**Statement:** Mutation of vault state happens only inside the engine routing layer. Every Effect emitted by a processor is routed through an engine chokepoint, capability-checked, and applied. Generic effect routes go through `src/engine/core/apply-effect.ts`; garden PatchEffects go through `src/engine/garden/garden-patch-dispatch.ts` and the shared sub-Proposal spawn boundary because they re-enter adoption instead of writing through an inline sink. No module outside the engine/storage layers reaches the mutation primitives (filesystem writes, git operations, SQLite inserts/updates).

**Why:** A single applier is what makes the engine's other guarantees concrete. The capability broker runs at this chokepoint; the run ledger writes at this chokepoint; diagnostics surface at this chokepoint. Multiple appliers would mean multiple capability checks, multiple ledger paths, multiple diagnostic surfaces — the system would lose the property that "every change can be explained by tracing back through the engine."

**Structural enforcement:**

1. **Exhaustive routing.** `src/engine/core/apply-effect.ts` carries a `switch (effect.kind)` over the eleven Effect kinds for generic sink routes, and `src/engine/garden/garden-patch-dispatch.ts` owns the garden PatchEffect special case. TypeScript's `never`-type exhaustiveness check fires on any unrouted generic kind. Adding another Effect without updating the route layer fails compilation.
2. **No mutation imports outside the engine.** The semantic linter `engine-is-sole-applier` ([[wiki/linters/engine-is-sole-applier]]) greps `src/` for imports of `node:fs`, `bun:sqlite`, `isomorphic-git`'s commit/write functions, and the outbox handler interfaces — outside `src/engine/`, `src/projections/`, and `src/ledger/`, these imports fail the lint.
3. **The background engine's sinks are constructed inside the engine layer.** `buildSqliteSinks` (in `src/projections/sinks.ts`) is composed by `src/engine/host/compiler-host.ts` against an open `VaultRuntime`; the writer-shaped `ApplyEffectSinks` object is consumed by engine route modules (`applyEffect`, garden patch routing, scheduler/jobs/answers). CLI commands choose vault paths, bundle roots, and output formatting, but do not assemble the background writer sinks.
4. **The capability broker is invoked only from the engine route layer.** `enforceCapability` is called from `apply-effect.ts`, `garden-patch-router.ts`, and the garden patch dispatch path; no non-engine module can bypass the broker.

**Counter-example:** A garden-phase processor uses dynamic import (`await import("node:fs")`) to bypass the static linter. The processor calls `fs.writeFile` — but the file written is in the working tree, *not* in the candidate tree the engine built from the adopted commit. The write is invisible to the current Proposal's adoption (which reads from the candidate); it surfaces on the next watcher cycle as `vault.out-of-band-edit`, becoming a new Proposal. So the bypass doesn't corrupt adopted state; it just produces a confusing second Proposal. The semantic linter is upgraded to flag dynamic imports of mutation modules in v1.1+.

**Test guarantee:** `tests/invariants/engine-is-the-only-applier.test.ts` is the AC3 lockstep marker. The active structural fence is `tests/integration/no-direct-mutation-outside-boundaries.test.ts`, which scans source files and rejects direct write APIs outside the approved engine/storage boundaries; effect routing behavior is covered by `tests/engine/apply-effect.test.ts` and `tests/engine/garden-patch-router.test.ts`.

## Implementation status

**As of the v1 cut (Phases 1–10 complete):**

- Structurally true now:
  - **Exhaustive routing** — `src/engine/core/apply-effect.ts:routeToSink` switches on `Effect.kind` with a `never`-typed `_exhaustive` catch-all. Adding another Effect without a route fails compilation.
  - **Engine-only enforcement call sites** — `enforceCapability` (from `src/engine/core/capability-broker.ts`) is invoked only from route modules under `src/engine/`. The broker module is not imported outside the engine.
  - **Sink injection shape is fixed** — `ApplyEffectSinks` enumerates the effect sinks and projection-maintenance hooks; the router is a pure dispatcher that owns no I/O of its own.
  - **Mutation modules confined to engine + storage layers.** Phase 7b retired `src/tools/`, `src/privileged-writer.ts`, `src/vault-dispatcher.ts`, and the other v0.5 mutation paths. The only modules under `src/` that import `bun:sqlite` are `src/{projections,outbox,ledger}/`; the only module that imports `isomorphic-git`'s commit/write functions is `src/git.ts`, consumed by `src/engine/core/closure-commit.ts`.

- Forward-looking (v1.x):
  - **The semantic linters `engine-is-sole-applier` and `no-direct-mutation-outside-engine`** ([[wiki/linters/engine-is-sole-applier]], [[wiki/linters/no-direct-mutation-outside-engine]]) are reviewable specs but not yet CI checks. The boundary is currently held by the type system (`ApplyEffectSinks` shape) and the deletion of v0.5 modules; the lints would catch future regressions.
  - **The v1.1+ dynamic-import linter upgrade** (counter-example mitigation against `await import("node:fs")` bypasses) is post-v1.

**Related:**
- [[wiki/specs/effects]] §"The Effect union" — the exhaustive switch
- [[wiki/specs/capabilities]] §"Enforcement chokepoint"
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]]
- [[wiki/invariants/EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT]]
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]]
