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

**Related:**
- [[wiki/specs/effects]] §"The Effect union" — the exhaustive switch
- [[wiki/specs/capabilities]] §"Enforcement chokepoint"
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]]
- [[wiki/invariants/EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT]]
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]]
