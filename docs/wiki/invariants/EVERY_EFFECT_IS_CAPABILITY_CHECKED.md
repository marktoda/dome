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

1. **One enforcement boundary.** `enforceCapability` is called from the engine routing layer exactly once per routed effect. Adoption, view, and non-patch garden effects go through `src/engine/apply-effect.ts`; garden PatchEffects go through `src/engine/garden-patch-dispatch.ts` / `src/engine/garden-patch-router.ts` because their destination is sub-Proposal construction. The broker is not exposed outside the engine.
2. **Returns `allow | downgrade | deny`.** The applier branches on the broker's verdict — `allow` applies the effect, `downgrade` rewrites it (e.g., PatchEffect `auto → propose`) and applies, `deny` writes a diagnostic and discards.
3. **Capability uses are ledgered.** Every effect enforcement decision writes a `CapabilityUse` row in the run ledger (per [[wiki/specs/run-ledger]] §"capability_uses"). Runtime-only privileged powers such as `model.invoke` use the same table at their context boundary. The audit surface for "what did this processor reach" is structural, not heuristic.
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

**Counter-example:** A processor declares `patch.auto: ["wiki/**"]` but is granted only `patch.auto: ["wiki/generated/**"]` in vault config. The processor emits a PatchEffect touching `wiki/entities/danny.md` (outside the grant). The broker returns `downgrade`: the effect is rewritten to `patch.propose`, a [[wiki/gotchas/capability-downgrade-surprise]] diagnostic is emitted, and adoption blocks until a review/apply surface is available or the user changes the grant/code.

**Test guarantee:** `tests/invariants/every-effect-is-capability-checked.test.ts` delegates per the convention above. The canonical enforcement test is `tests/integration/capability-enforcement.test.ts`.

## Implementation status

**As of the v1 cut (Phases 1–10 complete):**

- Structurally true now:
  - **One enforcement function, engine-only call sites.** `src/engine/capability-broker.ts:enforceCapability` is invoked only from the engine routing layer (`apply-effect.ts`, `garden-patch-dispatch.ts`, and `garden-patch-router.ts`). The verdict shape (`allow | downgrade | deny`) is closed and the applier branches on it.
  - **Verdict branching matches the spec.** `allow` routes the original effect, `downgrade` routes `verdict.rewrittenEffect`, `deny` returns `outcome: "denied"` with the broker's deny diagnostic.
  - **The Capability union is closed** in `src/core/processor.ts`. The bundle-manifest loader's Zod schemas in `src/extensions/manifest-schema.ts` validate declarations at registration boundary.
  - **The end-to-end runtime path is wired.** `dome sync` / `dome serve` open the runtime via `openVaultRuntime`, construct a manual Proposal from git state, call `adopt()`, and route returned Effects through the engine routing layer. Every Effect a processor emits passes through the broker before it can mutate state or write projections.
  - **Capability-use rows land in the ledger.** The routing layer returns a structured `capabilityUse` field for every enforced effect attempt, and callers persist it through `recordEffectCapabilityUse`. Runtime-only powers such as `model.invoke` record equivalent rows when the context function is called. The `capability_uses` table joins back to `runs` by `run_id`.
  - **Phase × kind compatibility check** runs upstream of the broker (`isPhaseCompatible` in `apply-effect.ts`); incompatible pairs produce a `phase-mismatch` diagnostic before the broker is consulted.
  - **Registration-time refusal of `model.invoke` on adoption-phase processors** is enforced by the manifest parser's phase × capability matrix; adoption stays deterministic and never receives `ctx.modelInvoke`.
  - **`model.invoke` quota tracking** runs at the model boundary rather
    than the Effect boundary. The runtime aggregates provider-reported
    `cost_usd` by extension-id prefix and denies further calls when the
    effective bundle-level daily cap is spent.

**Related:**
- [[wiki/specs/capabilities]]
- [[wiki/specs/effects]]
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]
- [[wiki/gotchas/capability-downgrade-surprise]]
- [[wiki/matrices/effect-x-capability]]
