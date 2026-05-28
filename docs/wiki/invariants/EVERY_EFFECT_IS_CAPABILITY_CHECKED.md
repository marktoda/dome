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

**As of the v1 cut (Phases 1–10 complete):**

- Structurally true now:
  - **One enforcement function, one call site.** `src/engine/capability-broker.ts:enforceCapability` is invoked exactly once from `src/engine/apply-effect.ts:applyEffect` and from nowhere else in `src/`. The verdict shape (`allow | downgrade | deny`) is closed and the applier branches on it.
  - **Verdict branching matches the spec.** `allow` routes the original effect, `downgrade` routes `verdict.rewrittenEffect`, `deny` returns `outcome: "denied"` with the broker's deny diagnostic.
  - **The Capability union is closed** in `src/core/processor.ts`. The bundle-manifest loader's Zod schemas in `src/extensions/manifest-schema.ts` validate declarations at registration boundary.
  - **The end-to-end runtime path is wired.** `dome sync` / `dome serve` open the runtime via `openVaultRuntime`, construct a manual Proposal from git state, call `adopt()`, which invokes the runtime's `adoptionRunner`, which feeds returned Effects through `applyEffect` — the broker's only caller. Every Effect a processor emits passes through the broker.
  - **Capability-use rows land in the ledger.** `src/engine/adopt.ts` calls `recordCapabilityUse` after each `applyEffect` returns a structured `capabilityUse` field. The `capability_uses` table joins back to `runs` by `run_id`.
  - **Phase × kind compatibility check** runs upstream of the broker (`isPhaseCompatible` in `apply-effect.ts`); incompatible pairs produce a `phase-mismatch` diagnostic before the broker is consulted.

- Forward-looking (v1.x):
  - **Registration-time refusal of `model.invoke` on adoption-phase processors** — the Capability schemas exist and the phase × trigger matrix is checked at manifest-parse time, but the phase × capability cross-field check (e.g., "adoption phase MUST NOT declare `model.invoke`") is a v1.1 tightening.
  - **`model.invoke` quota tracking** — `cost_usd` is a ledger column today; the `modelInvoke` wrapper that aggregates LLM token-cost across a run lands in v1.1.

**Related:**
- [[wiki/specs/capabilities]]
- [[wiki/specs/effects]]
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]
- [[wiki/gotchas/capability-downgrade-surprise]]
- [[wiki/matrices/effect-x-capability]]
