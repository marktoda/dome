---
type: invariant
created: 2026-07-04
updated: 2026-07-04
sources:
  - "[[wiki/specs/processor-execution]]"
  - "[[wiki/specs/capabilities]]"
  - "[[wiki/specs/cli]]"
description: A processor whose declared capability or declared context dependency is absent at run time surfaces a warning diagnostic; silent degradation on a declared need is a defect
enforced_by:
  - tests/invariants/needs-are-loud.test.ts
tier: shipped-default
---

# NEEDS_ARE_LOUD

**Tier:** Shipped default — enabled by default; the emission is unconditional (see "Deliberate narrowing" below for why there is no per-processor opt-out).

**Statement:** When the processor runtime constructs an invocation and finds that a **manifest-declared capability has an empty effective grant intersection**, or that a **declared read-view context dependency is absent at run time** (a declared `*.read` capability whose `ctx.operational` accessor the runtime resolves to nothing), it emits a **warning** `DiagnosticEffect` with code `processor.need-unmet` naming the processor and the unmet need. The processor **still runs** — degradation stays graceful; only the silence dies. The warning is deduped once per `(processorId, need)` per host session (in-memory; a restart re-emits, which is desirable — a fresh process should re-announce a still-unmet need).

**Why:** Dome's failure mode is *silent* degradation on a declared need — a processor keeps running but does nothing, and nothing says so. The owner debugs the silent no-op; a stranger concludes Dome doesn't work. This invariant generalizes a pattern with four documented incidents:

1. **The brief's questions block never rendered in 44 dailies.** `dome.agent.brief` declared it read the open-question batch, but `ctx.projection?.` optional-chained to empty in the garden phase — the block silently rendered nothing. (See [[cohesive/brainstorms/2026-07-01-product-review-daily-ritual]].)
2. **Grant-starved `dome.claims` processors silently skipped `notes/`.** The manifest declared `read notes/**`, the vault grant did not cover it, so the grant-scoped snapshot omitted the files and the processor never acted on them — no diagnostic.
3. **The historical model-provider silent no-op.** A model-capable processor with no configured provider produced nothing. Task 17 shipped the agent-specific host-start warning; this invariant is the general **run-time** complement.
4. **`dome init --refresh-config` never merged grants.** A vault that predated a bundle's newer behavior kept its old grant lists and silently lost that behavior — the kind was granted but the specific entry was not.

**Relationship to the config-time probe:** `dome doctor` already carries **config-time** grant-starvation probes — `capability.grant-missing` (a declared kind with no granted kind) and `capability.grant-starved` (a declared path pattern the effective grant misses, derived from a representative path; info severity). NEEDS_ARE_LOUD is the **run-time** complement: it fires from the live invocation against the grants the runtime actually resolved, so a starvation that only manifests once a processor is dispatched (or a vault that never runs `dome doctor`) still gets a loud, per-run, ledgered signal.

**Structural enforcement:**

1. **The emission site is the invocation-construction chokepoint.** `src/processors/runtime.ts`'s `dispatchOneProcessor` already resolves `declared = processor.capabilities` and `granted = resolveGrants(processor.id)` and computes the effective operational-read accessors. After the processor runs, `withNeedUnmetDiagnostics` computes the unmet needs from that same data and appends one `processor.need-unmet` warning per fresh need to the run's effect list.
2. **The warning rides the normal effect route.** Like the runtime's skip diagnostics, the appended `DiagnosticEffect` flows through `applyEffect`'s `DiagnosticEffect` route into `projection.db` attributed to this run — no engine import from the processor layer, no bespoke sink. `dome inspect diagnostics` is the durable operator surface.
3. **Two unmet-need classes are detected:**
   - *Empty kind-level intersection* — a declared capability kind with no granted capability of that kind (the general class; the run-time complement of `capability.grant-missing`).
   - *Absent operational read-view context field* — a declared `outbox.read` / `quarantine.read` / `run.read` / `questions.read` whose effective `ctx.operational` accessor is empty, even when the kind is nominally granted but the status intersection is empty (e.g. `run.read` `[running]` declared against `[succeeded]` granted).
   Finer path-glob starvation (declared `read wiki/**`, granted `read notes/**`) stays the doctor's representative-path probe; the runtime keys off what it resolves at invocation.
4. **The dedup set lives for the host session.** `ProcessorRuntime.needUnmetSeen` is created per `buildRuntime` and threaded through every dispatch path — the adoption/garden/view runners and the operational garden-run/answer-handler/store-changed paths (via `GardenRunDeps.needUnmetSeen`) — so a scheduled grant-starved processor warns once per session, not once per fire.

**Deliberate narrowing:** A vault MAY intentionally narrow a processor's grant. The doctor's `capability.grant-starved` probe suppresses the deliberate-narrowing case (a granted pattern strictly within the declared pattern) and is info severity for exactly this reason. The run-time probe here has **no such escape** — a wholly empty effective intersection for a declared kind, or an absent declared context accessor, is reported every session regardless of intent, because loud beats silent and the dedup keeps it to one warning per need per session. If a narrowing is deliberate, the warning is the acknowledgment cost; disable the processor/bundle rather than granting it a capability it must not have.

**Counter-example (the defect this forbids):** A processor declares `graph.write dome.claims` and `read notes/**`, the vault grants neither. Pre-invariant it ran, its FactEffects were denied by the broker, and its snapshot omitted `notes/` — producing nothing, saying nothing. Under NEEDS_ARE_LOUD it still runs, but a `processor.need-unmet` warning names the processor and each unmet need, so the no-op is never silent.

**Related:**
- [[wiki/specs/processor-execution]] — the runtime contract and the `processor.need-unmet` diagnostic code
- [[wiki/specs/capabilities]] — declared ∩ granted enforcement
- [[wiki/specs/cli]] — `dome doctor`'s config-time `capability.grant-missing` / `capability.grant-starved` probes
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]]
- [[wiki/invariants/EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT]]
