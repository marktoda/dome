---
type: gotcha
created: 2026-05-27
updated: 2026-05-27
severity: low
coverage: off-matrix
enforced_at: src/projections/db.ts
enforced_at_status: deferred
first_observed: 2026-05-27 (anticipated; surfaced in v1 design)
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
---

# Processor version drift

**Symptom:** After upgrading a bundle (a `dome.*` first-party bundle via SDK upgrade, or a third-party bundle via reinstall), some facts in `projection.db.facts` are still produced by the older processor version. Queries return both old-format and new-format facts mixed together; some downstream consumers (semantic search, view-phase renderers) see inconsistent results.

**Root cause:** A processor's `version` field changed (`1.0.0` → `1.1.0`) — possibly because the upgrade improved fact-extraction logic, changed predicate names, or added new predicates. The projection store's `processorVersionsHash` cache key changed; the engine should invalidate the affected rows; but if the invalidation didn't run (e.g., projection wasn't rebuilt yet), stale rows persist.

**Structural mitigation:** **Auto-invalidate on processor-version change at `openVault`.**

The projection store's three-part cache key per [[wiki/specs/projection-store]] §"Cache key" includes `processorVersionsHash`. On `openVault`:

1. The engine computes the current `processorVersionsHash` from `Object.entries(loadedProcessors).map(p => `${p.id}:${p.version}`).sort()`.
2. Compares to `projection_meta.processor_versions_hash` in the existing `projection.db`.
3. If they match: open normally.
4. If they mismatch: identify which processor versions changed; invalidate rows in tables those processors wrote to (`facts` rows with matching `processor_id`; `diagnostics` rows similarly).
5. Re-run the changed processors against the adopted snapshot to repopulate.

Partial invalidation is what makes the upgrade fast — a single-processor version bump invalidates only that processor's facts, not the entire projection. A full `dome rebuild` is the heavyweight option; the per-processor invalidation is the per-upgrade lightweight path.

The user sees:
```text
dome: processor versions changed (dome.intake.extract-capture 1.0.0 → 1.1.0); re-running...
  invalidating 47 facts; re-running garden-phase emitters against adopted commit 41a98c2...
  done (3.2s)
```

**Specific scenarios:**

- **SDK upgrade with bundled processor bump.** SDK v1.2 ships `dome.intake.extract-capture@1.1.0` (improved capture compilation). On upgrade, the engine invalidates the previous version's facts and re-runs the new version against existing captures. Fact provenance updates; downstream queries return consistent results.

- **Schema bump within a processor.** A processor changes its fact predicate scheme (`dome.tasks.dueDate` → `dome.tasks.due_date`). The version bumps; old rows invalidate; new rows use the new predicate. Consumers that joined on the old predicate need to update — but the structural invalidation makes the change visible (queries return zero results for the old name) rather than silent.

- **Third-party bundle reinstall without version bump.** A user downloads a new copy of `community.bundle` but the version stays `1.0.0`. The engine doesn't know about the change; the old facts persist. Workaround: the bundle author should bump the version on every release; until they do, the user runs `dome rebuild` to force a full reset.

**Operational notes:**

- The invalidation happens at `openVault` — the same place the schema-skew detection happens. If both schema AND processor-versions changed, the full schema-rebuild covers the processor-version invalidation by side effect.
- The integration test `tests/integration/processor-version-drift.test.ts` exercises the version-bump invalidation path.
- A processor that *forgets* to bump its version when its emission shape changed is a bug in the processor author's release process, not in the engine. The engine treats `(processor_id, version)` as the cache key; same key = same emissions, by contract.

**Related:**
- [[wiki/specs/projection-store]] §"Cache key"
- [[wiki/specs/processors]] §"Idempotency"
- [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]]
- [[wiki/gotchas/projection-schema-skew]]
- [[wiki/gotchas/processor-idempotency]]
