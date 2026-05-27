---
type: invariant
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
tier: axiom
---

# ENGINE_IS_THE_ONLY_APPLIER

**Tier:** Axiom — non-disable-able.

**Statement:** Mutation of vault state happens exactly one place: `src/engine/apply-effect.ts`. Every Effect emitted by a processor is routed through this chokepoint, capability-checked, and applied. No other module in the SDK reaches the mutation primitives (filesystem writes, git operations, SQLite inserts/updates).

**Why:** A single applier is what makes the engine's other guarantees concrete. The capability broker runs at this chokepoint; the run ledger writes at this chokepoint; diagnostics surface at this chokepoint. Multiple appliers would mean multiple capability checks, multiple ledger paths, multiple diagnostic surfaces — the system would lose the property that "every change can be explained by tracing back through the engine."

**Structural enforcement:**

1. **Exhaustive routing.** `src/engine/apply-effect.ts` carries a `switch (effect.kind)` over the seven Effect kinds. TypeScript's `never`-type exhaustiveness check fires on any unrouted kind. Adding an 8th Effect without updating the switch fails compilation.
2. **No mutation imports outside the engine.** The semantic linter `engine-is-sole-applier` ([[wiki/linters/engine-is-sole-applier]]) greps `src/` for imports of `node:fs`, `bun:sqlite`, `isomorphic-git`'s commit/write functions, and the outbox handler interfaces — outside `src/engine/`, `src/projections/`, and `src/ledger/`, these imports fail the lint.
3. **The engine's writer is module-private.** `src/engine/writer.ts` is not exported from any package entrypoint. Code outside `src/engine/` cannot reach it.
4. **The capability broker is invoked from one place.** `enforceCapability` is called from `apply-effect.ts` and nowhere else; greppable via `tests/integration/capability-enforcement.test.ts`'s import-graph check.

**Counter-example:** A garden-phase processor uses dynamic import (`await import("node:fs")`) to bypass the static linter. The processor calls `fs.writeFile` — but the file written is in the working tree, *not* in the candidate tree the engine built from the adopted commit. The write is invisible to the current Proposal's adoption (which reads from the candidate); it surfaces on the next watcher cycle as `vault.out-of-band-edit`, becoming a new Proposal. So the bypass doesn't corrupt adopted state; it just produces a confusing second Proposal. The semantic linter is upgraded to flag dynamic imports of mutation modules in v1.1+.

**Test guarantee:** `tests/invariants/engine-is-the-only-applier.test.ts` (off-matrix; delegates to `tests/integration/engine-is-sole-applier.test.ts`) — walks the SDK's import graph and asserts no module outside the engine + projections + ledger directories imports mutation modules.

## Implementation status

**As of Phase 1+2 (engine layer landed; v0.5 Tools surface still live):**

The engine chokepoint exists structurally; the *only-applier* property is forward-looking because the v0.5 Tools / privileged-writer mutation paths still ship.

- Structurally true now:
  - **Exhaustive routing** — `src/engine/apply-effect.ts:routeToSink` switches on `Effect.kind` with a `never`-typed `_exhaustive` catch-all. Adding an 8th Effect without a route fails compilation today.
  - **One enforcement-broker call site** — `enforceCapability` (from `src/engine/capability-broker.ts`) is invoked only from `apply-effect.ts:applyEffect`. The broker module is not imported anywhere else under `src/`.
  - **Sink injection shape is fixed** — `ApplyEffectSinks` enumerates the seven sink callbacks; the router is a pure dispatcher that owns no I/O of its own.

- Forward-looking (lands in later phases):
  - **`src/engine/writer.ts` does not yet exist.** The invariant's bullet 3 references a module-private writer that ships with the Phase 4 projection-store wiring (the file lands when the real sinks replace `noopSinks()`).
  - **The semantic linters `engine-is-sole-applier` and `no-direct-mutation-outside-engine`** ([[wiki/linters/engine-is-sole-applier]], [[wiki/linters/no-direct-mutation-outside-engine]]) are reviewable specs but not yet CI checks. They ship in Phase 10 cleanup. Until then, the boundary is reviewer-enforced.
  - **Mutation imports outside `src/engine/` still exist by design.** `src/tools/`, `src/privileged-writer.ts`, `src/workflow-commit.ts`, and others reach `Bun.write`, `node:fs`, and `isomorphic-git` directly — these are the v0.5 paths Phase 7 retires. The lint that catches them is meaningful only after those modules are deleted.
  - **The integration test `tests/integration/engine-is-sole-applier.test.ts`** ships when the engine sinks are wired (Phase 4) and the Tools surface is retired (Phase 7); running it earlier would flag every legitimate v0.5 mutation path.
  - **The v1.1+ dynamic-import linter upgrade** (counter-example mitigation) is post-v1.

Until Phase 4 + Phase 7, "engine is the only applier" is the v1 contract the substrate pins; the live v0.5 mutation paths coexist as the actual write surface.

**Related:**
- [[wiki/specs/effects]] §"The Effect union" — the exhaustive switch
- [[wiki/specs/capabilities]] §"Enforcement chokepoint"
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]]
- [[wiki/invariants/EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT]]
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]]
