---
type: invariant
created: 2026-05-27
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
description: Every vault mutation passes through a Proposal and adopt() in the engine; the SDK exports no direct-write API or privileged escape hatch
enforced_by:
  - tests/integration/public-surface-shape.test.ts
  - tests/integration/no-direct-mutation-outside-boundaries.test.ts
tier: axiom
---

# PROPOSALS_ARE_THE_ONLY_WRITE_PATH

**Tier:** Axiom — non-disable-able. Disabling it changes what Dome is.

**Statement:** Every mutation to vault state — human edit, agent write, garden-emitted patch, intake compilation, scheduled job — passes through a `Proposal` and the engine's adoption loop. In v1.0 the engine-internal compiler host/sync path is the only local runtime that constructs user-write Proposals and calls `adopt()`; there is no direct-write API on the SDK and no privileged escape hatch for internal code.

**Why:** One write path is what makes the engine's guarantees tractable. Adoption is the only place capability enforcement runs, diagnostics are surfaced, the run ledger writes, and the projection store updates. A "trusted internal write" bypass would dissolve every property the engine layer provides — the design would degrade into the v0.5 model where some writes were Tool-enforced and others (the privileged-writer) weren't.

**Structural enforcement:**

1. **`src/index.ts` has no exports for direct mutation.** `vault.tools.writeDocument(...)` does not exist. No public submit-style API is exposed either — engine-internal runtime code is the only caller of `adopt()` in v1.0.
2. **The engine routing layer is the only layer that reaches vault mutation primitives.** Git and filesystem writes are confined to the engine/git boundaries; SQLite writes are confined to the projection, ledger, outbox, and answers stores.
3. **The semantic linter `no-direct-mutation-outside-engine`** ([[wiki/linters/no-direct-mutation-outside-engine]]) greps `src/` for mutation calls outside the approved engine/storage boundaries. v1 ships this as a structural fence rather than reviewer-memory enforcement.
4. **The capability broker is called only from engine routing modules.** Processors receive a scoped `ProcessorContext`, not broker handles or sinks; the only supported way to request mutation is to return an Effect and let the engine route it.

**Counter-example:** A garden-phase processor that wants to "quickly fix a typo" by calling `bun.write(path, content)` directly — bypassing the loop, the broker, and the ledger. The semantic linter flags the call at CI; if it slipped through, the write would land as ordinary working-tree drift and have to pass through a later `dome sync` Proposal before becoming adopted state.

**Test guarantee:** `tests/invariants/proposals-are-the-only-write-path.test.ts` — for each shipped-default processor, asserts the processor's `run()` returns Effects without performing direct mutations (verified by typecheck + by running the processor against a read-only filesystem mock that throws on any write attempt).

## Implementation status

- Structurally true now:
  - `src/core/effect.ts` carries the closed eleven-kind Effect union — the only legal write-side payload shape a processor can emit.
  - `src/engine/core/apply-effect.ts` is the sole applier for Effects; `routeToSink` is an exhaustive switch on the sink routes, and a garden auto-mode PatchEffect resolves to the `queued-for-spawn` outcome there before the garden orchestrator turns it into a sub-Proposal.
  - `src/engine/core/capability-broker.ts:enforceCapability` is the single enforcement function, called only from engine route modules.
  - `src/engine/core/adopt.ts:adopt()` is the only function that mutates trusted state. There is no public submit-style API in `src/index.ts`; Proposals are constructed internally by engine code and routed through `adopt()`.
  - `src/index.ts` does NOT export `writeDocument`, `moveDocument`, `deleteDocument`, `appendLog`, or the privileged-writer surface — those v0.5 paths were retired entirely.
  - `src/index.ts` does NOT export `submitProposal`, the Proposal source-constructors, or `openVaultRuntime` — the engine-internal write path is not reachable from SDK consumers in v1.0. The retired `submitProposal({runtime, proposal})` ceremony (Phase 11a demolition) was the wrong shape; the canonical v1.0 write path is `git commit` + the engine's adoption-on-new-commit run.
  - The `Proposal` type carries a 2-way internal `ProposalSource` union (`manual` + `garden`); `makeManualProposal` in `src/core/proposal.ts` is the single internal constructor used by the compiler host/sync path when it observes branch/adopted drift.
  - **The local compiler host (`dome serve`)** is the long-running process that calls `adopt()` against client-driven Proposals. It watches `refs/heads/<branch>`, compares against `refs/dome/adopted/<branch>`, constructs a `manual`-source Proposal via `makeManualProposal`, and routes it through the engine. `dome sync` uses the same internal construction path for one-shot catch-up.
  - **`PatchEffect` application is shipped.** Adoption-phase PatchEffects mutate the candidate tree through `src/engine/core/apply-patch.ts`; garden PatchEffects become internal garden-source Proposals and re-enter `adopt()`.
  - **The semantic linter `no-direct-mutation-outside-engine`** is active as `tests/integration/no-direct-mutation-outside-boundaries.test.ts`.

**Related:**
- [[wiki/specs/proposals]]
- [[wiki/specs/adoption]]
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]]
- [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]]
