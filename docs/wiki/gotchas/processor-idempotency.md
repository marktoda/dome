---
type: gotcha
created: 2026-05-27
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
coverage: off-matrix
description: Non-idempotent processors emit different effects on identical (snapshot, input), causing duplicate facts, divergence, and rebuild mismatches.
enforced_at: src/engine/core/adopt.ts (fixed-point detection)
enforced_at_status: deferred
first_observed: 2026-05-27 (carried forward from v0.5's hook-non-idempotent)
severity: high
---

# Processor idempotency

**Symptom:** A processor runs against the same `(snapshot, input)` twice and produces different effects. Visible as: duplicate facts in `projection.db.facts`, duplicate diagnostics, the adoption loop diverging at the fixed-point check, or `dome rebuild` producing a different `projection.db` than the original sync did.

**Root cause:** The processor's `run(ctx)` body has non-deterministic behavior. The most common sources:

1. **Embedded timestamps.** `effect.message = "extracted at " + Date.now()` — the message changes every run.
2. **Random IDs.** Generating UUIDs for facts at run time, rather than deriving them from the input.
3. **External state read.** Calling an external API and using the response in an effect, where the API's response varies per call.
4. **LLM non-determinism.** Calling `ctx.modelInvoke` with `temperature > 0`; the LLM's output is non-deterministic.

**Why it's required:** The engine's fixed-point loop depends on idempotency. Each iteration runs adoption-phase processors against the candidate tree; if a processor emits a different effect set on iteration N+1 than on N, the candidate keeps changing and the loop never converges. Beyond the loop, `dome rebuild` re-runs every adoption-phase processor + every garden-phase fact-emitter; non-idempotent emissions cause the rebuild to drift from the original.

**Structural mitigation:** **Idempotency is a processor-author responsibility; the engine catches the failure mode loudly.**

The engine cannot statically prove idempotency, but it can detect failure:

1. **Fixed-point divergence.** The adoption loop catches non-idempotent adoption-phase processors via the `MAX_ITER` cap. See [[wiki/gotchas/processor-fixed-point-divergence]].
2. **Rebuild divergence test.** `tests/integration/projection-rebuildability.test.ts` syncs a fixture vault, snapshots `projection.db`, deletes it, runs `dome rebuild`, asserts the snapshot matches. A non-idempotent garden-phase fact-emitter fails this test.
3. **Duplicate-fact dedup at the projection layer.** `projection.db.facts` has a uniqueness constraint on `(processor_id, subject_kind, subject_id, predicate, object_json)`. A processor that emits the same fact twice deduplicates; a processor that emits subtly-different facts (timestamp embedded in `object_json`) does not — surfacing as bloat in the table over time.
4. **LLM-driven processors are required to use deterministic seeds.** `ctx.modelInvoke` passes `temperature: 0` by default for adoption-phase processors and exposes a `temperature?` option for garden-phase processors. Garden-phase LLM use with temperature > 0 should produce effects that are *idempotent up to confidence-level* — the FactEffect's `confidence` field absorbs the variance.

**Specific scenarios:**

- **Ingest LLM compile.** An ingest-style garden-LLM processor calls the model with temperature 0 to produce a deterministic compilation. The same capture twice produces the same wiki updates. Even if the LLM is upgraded between runs, the *commit* (which is what `dome rebuild` re-derives) doesn't change unless the input does.

- **Stable-id generation.** A processor that wants to add a stable ID to a task line MUST derive the ID from the line's content + position, not from `Math.random()` or `crypto.randomUUID()`. The convention in v1: `task-id = sha1(commit_oid + path + line_number + task_text).slice(0, 8)` — deterministic given a fixed snapshot.

- **External-state read.** A processor that wants to enrich a fact with external data (e.g., "look up this person on LinkedIn") MUST emit `ExternalActionEffect` for the lookup; the engine's outbox + idempotency key dedups the call across re-runs. The fact derived from the response uses the response's stable identifier (e.g., the LinkedIn person id), not the response's volatile fields.

**Operational notes:**

- Test every processor with: run twice on the same input; assert effects are byte-equivalent. The shipped-default processor tests follow this pattern (see `tests/processors/dome-*-idempotency.test.ts`).
- A user who suspects a processor is non-idempotent runs `dome rebuild` and watches for the projection diverging from the original. The rebuild-divergence test catches this in CI; users see it as projection bloat.
- The LLM-driven processors carry their prompt + temperature in their `.prompt.md` files; reviewers can verify the prompt is deterministic-friendly.

**Related:**
- [[wiki/specs/processors]] §"Idempotency"
- [[wiki/gotchas/processor-fixed-point-divergence]]
- [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]]
