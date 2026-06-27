---
type: invariant
created: 2026-06-03
updated: 2026-06-26
sources:
  - "[[wiki/specs/task-lifecycle]]"
description: Garden processors with model.invoke cannot declare graph.write; model judgment surfaces as questions or patches, never rebuild-lost FactEffects
enforced_by:
  - tests/invariants/model-processors-emit-no-durable-facts.test.ts
  - tests/extensions/manifest-schema.test.ts
tier: axiom
---

# MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS

**Tier:** Axiom — non-disable-able.

**Statement:** A garden-phase processor granted `model.invoke` must NOT declare `graph.write`. Model-derived judgment is transient: it may surface as a `QuestionEffect` — made durable only by the human/agent resolution recorded in `answers.db`, which rehydrates on rebuild — or as a regenerated generated-surface `PatchEffect`. It must never surface as a `FactEffect`, because a fact emitted by a model call would silently vanish on the next `dome rebuild`.

**Why:** Projection rebuild re-runs only the processors whose output it can faithfully reconstruct from the adopted commit. A `model.invoke` call is non-deterministic and is deliberately excluded from rebuild (`projection-rebuild` makes no model calls by design). If a garden model processor wrote a `FactEffect` into `projection.db.facts`, that fact would be present in the live projection but absent after a wipe-and-rebuild — the projection would no longer be reconstructable from adopted markdown, breaking [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] and, through it, [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]. The two durable channels a warden is allowed to use are rebuild-safe instead: a question's *answer* lives in `answers.db` and is reapplied on rebuild; a generated-surface patch is regenerated from adopted state by re-running the (cron-driven) processor. Both keep the source of truth in markdown + `answers.db`, never in a transient model judgment.

**Structural enforcement:**

1. **The rebuild-safe garden capability set excludes `model.invoke`.** `src/engine/host/projection-rebuild.ts` defines `REBUILD_SAFE_GARDEN_CAPABILITIES = {read, graph.write, search.write, question.ask}`. `isRebuildEligibleGardenProcessor` re-runs a garden processor during rebuild only if *every* declared capability is in that set. A garden processor holding `model.invoke` therefore never re-runs on rebuild — so any `FactEffect` it emitted would not be reconstructable.
2. **The manifest-level rule makes the unsafe combination impossible by construction.** No garden `model.invoke` processor declares `graph.write`. With that rule held, the only durable effects a garden model processor can emit are `QuestionEffect` (durability supplied by `answers.db`) and a narrowly-scoped `PatchEffect` (durability supplied by the committed markdown that is the `PatchEffect`'s output) — both rebuild-safe. The shipped warden follows this: `dome.warden.integrity` declares `read` + `model.invoke` (no `graph.write`, no `patch.auto`). Its findings surface as `DiagnosticEffect`s — transient model judgment that regenerates each garden run and self-clears when the page is reconciled, so nothing durable is lost on rebuild. The `dome.agent.ingest` processor follows the same rule: it declares `read` + `model.invoke` + `patch.auto` + `question.ask` and never `graph.write`; its durable output is committed markdown via `PatchEffect`.

**Counter-example:** A "smart tagger" warden runs in the garden phase with `model.invoke` and is also granted `graph.write`. It asks the model to infer topic tags for a page and emits a `FactEffect` (`page.topic = "infra"`) per inference. The fact lands in `projection.db.facts`. The user wipes `projection.db` and runs `dome rebuild`; rebuild walks the adopted commit and re-runs rebuild-eligible processors, but the tagger holds `model.invoke` and is skipped — no model calls happen during rebuild. The inferred facts are gone, and the rebuilt projection no longer matches the live one. The fix is structural, not a retry: the tagger must surface its judgment as a `QuestionEffect` (durable via `answers.db`) or as a regenerated generated-surface patch, and must drop `graph.write`.

**Test guarantee:** `tests/invariants/model-processors-emit-no-durable-facts.test.ts` loads all shipped bundles via `loadBundles({ bundlesRoot: resolveShippedBundlesRoot() })` and asserts that no processor with `phase === "garden"` declaring a `model.invoke` capability also declares a `graph.write` capability. It also pins the invariant doc into the AC3 lockstep surface at its canonical path.

**Related:**
- [[wiki/specs/task-lifecycle]] §"Wardens" — the warden pattern this invariant guards
- [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] — the parent property a durable model fact would break
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — the property rebuildability makes concrete
- [[wiki/specs/capabilities]] — `model.invoke` and `graph.write` capability tiers
- [[wiki/specs/effects]] — `QuestionEffect`, `FactEffect`, `PatchEffect`
