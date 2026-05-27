---
type: invariant
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
tier: axiom
---

# EVERY_EFFECT_IS_CAPABILITY_CHECKED

**Tier:** Axiom — non-disable-able.

**Statement:** Every Effect emitted by a Processor passes through `enforceCapability(effect, processor.capabilities, vault.grants)` before the engine applies it. The intersection of declared capabilities and granted capabilities determines whether the effect is allowed, downgraded, or denied.

**Why:** Capabilities are the scoping mechanism that lets first-party and third-party extensions register through the same path without granting third-party code the power of first-party code. Without enforcement at the chokepoint, every processor would have the engine's full mutation reach — there would be no meaningful trust boundary.

**Structural enforcement:**

1. **One enforcement point.** `enforceCapability` is called from `src/engine/apply-effect.ts` exactly once per effect. No other module calls it; the broker is not exposed outside the engine.
2. **Returns `allow | downgrade | deny`.** The applier branches on the broker's verdict — `allow` applies the effect, `downgrade` rewrites it (e.g., PatchEffect `auto → propose`) and applies, `deny` writes a diagnostic and discards.
3. **Capability uses are ledgered.** Every enforcement decision writes a `CapabilityUse` row in the run ledger (per [[wiki/specs/run-ledger]] §"capability_uses"). The audit surface for "what did this processor reach" is structural, not heuristic.
4. **Adoption-phase processors can't request `model.invoke`.** The bundle loader rejects manifests where an adoption-phase processor declares `model.invoke` capability — the broker refuses at registration time, not runtime.
5. **The integration test exercises every Effect kind × every Capability tier.** `tests/integration/capability-enforcement.test.ts` ships positive and negative cases per pair per [[wiki/matrices/effect-x-capability]].

**Off-matrix lockstep convention:** This invariant is enforced at the engine boundary, not at a processor's call site. The lockstep test file at `tests/invariants/every-effect-is-capability-checked.test.ts` uses the delegating-stub shape:

```ts
import { describe, test } from "bun:test";

describe("EVERY_EFFECT_IS_CAPABILITY_CHECKED (off-matrix)", () => {
  test("enforced by tests/integration/capability-enforcement.test.ts", async () => {
    await import("../integration/capability-enforcement.test");
  });
});
```

The dynamic `import()` runs the linked test file's describe/test blocks; a regression in capability enforcement fails the lockstep stub.

**Counter-example:** A processor declares `patch.auto: ["wiki/**"]` but is granted only `patch.auto: ["wiki/generated/**"]` in vault config. The processor emits a PatchEffect touching `wiki/entities/danny.md` (outside the grant). The broker returns `downgrade`: the effect is rewritten to `patch.propose`, a [[wiki/gotchas/capability-downgrade-surprise]] diagnostic is emitted, the patch lands as a proposal for the user to review via `dome lint --apply`.

**Test guarantee:** `tests/invariants/every-effect-is-capability-checked.test.ts` delegates per the convention above. The canonical enforcement test is `tests/integration/capability-enforcement.test.ts`.

## Implementation status

**As of Phase 1+3 (engine layer + processor runtime landed; end-to-end invocation path forward-looking):**

The enforcement function exists, the runner exists, and the structural fence between them is wired — but no caller yet drives a processor through the runner in production. The chokepoint is real; what flows through it in shipped code paths isn't.

- Structurally true now:
  - **One enforcement function, one call site.** `src/engine/capability-broker.ts:enforceCapability` is invoked exactly once from `src/engine/apply-effect.ts:applyEffect` and from nowhere else in `src/`. The verdict shape (`allow | downgrade | deny`) is closed and the applier branches on it (`apply-effect.ts:222-235`).
  - **Verdict branching matches the spec.** `allow` routes the original effect, `downgrade` routes `verdict.rewrittenEffect` (e.g., PatchEffect `auto → propose`), `deny` returns `outcome: "denied"` with the broker's deny diagnostic — all three paths exist in code today.
  - **The Capability union is closed** (`src/core/processor.ts`: `Read | PatchPropose | PatchAuto | OwnsRegion | OwnsPath | GraphWrite | ModelInvoke | External`). The bundle-manifest loader's per-field Zod schemas validate declarations at registration boundary.
  - **The `AdoptionPhaseRunner` contract is satisfied.** `src/processors/runtime.ts:buildRuntime` walks the registry, matches triggers, invokes processors, and feeds the returned Effects into `applyEffect` — which is the only call site that invokes the broker. The structural fence (runner → applyEffect → broker) is statically wired by the type contract.

- Forward-looking (lands in later phases):
  - **The runner is dormant — no production caller exercises it yet.** Nothing outside `src/processors/` imports `buildRuntime`. The end-to-end invocation path (`vault.submitProposal(...)` → engine → runner → broker → sink) lands in Phase 7, when `submitProposal` is exported and `src/vault.ts` is rewired off `vault.tools`. Until that wiring lands, the broker fires only from Phase 2 unit tests and the runner's own tests; no shipped caller drives a processor through it.
  - **`CapabilityUse` ledger rows** depend on `src/ledger/` (Phase 8). The `capability_uses` table and the per-effect ledger write are part of the run-ledger implementation, not the Phase 2 router.
  - **Registration-time refusal of `model.invoke` on adoption-phase processors** (bullet 4) requires the bundle loader's per-processor manifest validator (Phase 6); the Capability schemas exist but the cross-field check at load time ships with the validator.
  - **The capability broker is currently a Phase 2 placeholder** per the brainstorm phasing — Phase 5 tightens it (full per-tier semantics, downgrade-surprise diagnostics in canonical shape, model.invoke quota tracking).
  - **`tests/integration/capability-enforcement.test.ts`** (the Effect-kind × Capability-tier matrix) ships when Phase 5 lands; the lockstep stub at `tests/invariants/every-effect-is-capability-checked.test.ts` is reviewable substrate now.

The chokepoint and the runner are both built and structurally connected; the *runtime coverage* claim ("every Effect a Processor emits in production passes through the broker") becomes true once Phase 7 wires `submitProposal` to the runner.

**Related:**
- [[wiki/specs/capabilities]]
- [[wiki/specs/effects]]
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]
- [[wiki/gotchas/capability-downgrade-surprise]]
- [[wiki/matrices/effect-x-capability]]
