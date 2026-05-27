---
type: invariant
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
tier: axiom
---

# PROPOSALS_ARE_THE_ONLY_WRITE_PATH

**Tier:** Axiom — non-disable-able. Disabling it changes what Dome is.

**Statement:** Every mutation to vault state — human edit, agent write, garden-emitted patch, intake compilation, scheduled job — passes through `submitProposal` and the engine's adoption loop. There is no direct-write API on the SDK and no privileged escape hatch for internal code.

**Why:** One write path is what makes the engine's guarantees tractable. Adoption is the only place capability enforcement runs, diagnostics are surfaced, the run ledger writes, and the projection store updates. A "trusted internal write" bypass would dissolve every property the engine layer provides — the design would degrade into the v0.5 model where some writes were Tool-enforced and others (the privileged-writer) weren't.

**Structural enforcement:**

1. **`src/index.ts` has no exports for direct mutation.** `vault.tools.writeDocument(...)` does not exist. The only write-side export is `submitProposal`.
2. **The engine's `apply-effect.ts` is the only module that reaches mutation primitives.** No `bun.write`, `fs.writeFile`, `git.commit`, or `db.execute("INSERT ...")` call outside `src/engine/`.
3. **The semantic linter `no-direct-mutation-outside-engine`** ([[wiki/linters/no-direct-mutation-outside-engine]]) greps `src/` for mutation calls outside `src/engine/` and `src/projections/`. v1 ships this as a structural fence rather than reviewer-memory enforcement.
4. **The capability broker rejects effects emitted outside the engine boundary.** A processor that calls `enforceCapability` directly (rather than emitting an Effect for the engine to route) crashes the run with `engine-bypass-attempt`.

**Counter-example:** A garden-phase processor that wants to "quickly fix a typo" by calling `bun.write(path, content)` directly — bypassing the loop, the broker, and the ledger. The semantic linter flags the call at CI; if it slipped through, the broker would catch the missing capability use at runtime; if it slipped through both, the run ledger would show a closure commit with no corresponding RunRecord — diagnostic surfaced via `dome doctor --orphan-runs`.

**Test guarantee:** `tests/invariants/proposals-are-the-only-write-path.test.ts` — for each shipped-default processor, asserts the processor's `run()` returns Effects without performing direct mutations (verified by typecheck + by running the processor against a read-only filesystem mock that throws on any write attempt).

## Implementation status

**As of the v1 cut (Phases 1–10 complete):**

- Structurally true now:
  - `src/core/effect.ts` carries the closed 7-kind Effect union — the only legal write-side payload shape a processor can emit.
  - `src/engine/apply-effect.ts:applyEffect` is the sole router for Effects; its `routeToSink` is an exhaustive switch on `Effect.kind` with a `never`-typed catch-all — adding an 8th effect kind without a route fails compilation.
  - `src/engine/capability-broker.ts:enforceCapability` is the single enforcement function, called only from `apply-effect.ts`.
  - `src/engine/submit-proposal.ts` exports `submitProposal({runtime, proposal})` — the only public write path. `src/index.ts` exports it as the top-level surface.
  - `src/index.ts` does NOT export `writeDocument`, `moveDocument`, `deleteDocument`, `appendLog`, or the privileged-writer surface — Phase 7b retired `src/tools/` + `src/privileged-writer.ts` entirely.
  - The five Proposal source-constructors (`clientProposal`, `agentProposal`, `gardenProposal`, `manualProposal`, `importProposal`) are the only paths to a valid `Proposal`; each freezes its output.

- Forward-looking (v1.x):
  - **`PatchEffect` application** — `src/engine/submit-proposal.ts`'s injected `applyPatch` is a placeholder that throws if invoked. v1 ships the routing + capability + ledger machinery; the candidate-tree mutator that actually applies patches in adoption-phase lands in v1.1. Until then, the only effects that successfully route through `submitProposal` are non-patch kinds (diagnostic, fact, question, job, external, view). Per `effect-router-targets.md`, this is the only Phase 7a placeholder that survives into v1.0.
  - **The semantic linter `no-direct-mutation-outside-engine`** ([[wiki/linters/no-direct-mutation-outside-engine]]) is a reviewable spec but not yet a CI check.

**Related:**
- [[wiki/specs/proposals]]
- [[wiki/specs/adoption]]
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]]
- [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]]
