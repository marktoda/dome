---
type: gotcha
created: 2026-05-27
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
coverage: off-matrix
description: After a bundle upgrade, projection.db retains facts from the old processor version, mixing old- and new-format facts in query results.
enforced_at: src/projections/db.ts
enforced_at_status: shipped
first_observed: 2026-05-27 (anticipated; surfaced in v1 design)
severity: low
---

# Processor version drift

**Symptom:** After upgrading a bundle (a `dome.*` first-party bundle via SDK upgrade, or a third-party bundle via reinstall), some facts in `projection.db.facts` are still produced by the older processor version. Queries return both old-format and new-format facts mixed together; some downstream consumers (semantic search, view-phase renderers) see inconsistent results.

**Root cause:** A processor's `version` field changed (`1.0.0` → `1.1.0`) — possibly because the upgrade improved fact-extraction logic, changed predicate names, or added new predicates. The projection store's `processorVersionsHash` cache key changed; any existing projection rows may now describe the old processor set.

**Structural mitigation:** **Auto-rebuild projections from adopted state on cache-key drift.**

The projection store's cache key per [[wiki/specs/projection-store]] §"Cache key" includes `processorVersionsHash` alongside adopted commit, extension set, and capability policy hashes. On `openVault`:

1. The engine computes the current `processorVersionsHash` from `Object.entries(loadedProcessors).map(p => `${p.id}:${p.version}`).sort()`.
2. Compares to `projection_meta.processor_versions_hash` in the existing `projection.db`.
3. If they match: open normally.
4. If they mismatch: before operational/view work reads projections, Dome resets projection tables and rebuilds diagnostic/fact/question rows from the current adopted commit with the loaded processor set.

This is intentionally full-rebuild first. It is simpler, correct for bundle add/remove/version changes, and relies on the invariant that projections are rebuildable from markdown plus processor definitions. Per-processor invalidation can be added later as an optimization, but it is not the correctness boundary.

The user sees:
```text
dome sync
# projection cache-key drift is handled before in-sync operational work;
# stale rows do not survive the command.
```

**Specific scenarios:**

- **SDK upgrade with bundled processor bump.** SDK v1.2 ships `dome.agent.ingest@1.1.0` (improved ingest behavior). On upgrade, the engine rebuilds projections from the adopted commit with the new processor set. Fact provenance updates; downstream queries return consistent results.

- **Schema bump within a processor.** A processor changes its fact predicate scheme (`dome.tasks.dueDate` → `dome.tasks.due_date`). The version bumps; old rows invalidate; new rows use the new predicate. Consumers that joined on the old predicate need to update — but the structural invalidation makes the change visible (queries return zero results for the old name) rather than silent.

- **Third-party bundle reinstall without version bump.** A user downloads a new copy of `community.bundle` but the version stays `1.0.0`. The engine doesn't know about the change; the old facts persist. Workaround: the bundle author should bump the version on every release; until they do, the user runs `dome rebuild` to force a full reset.

**Operational notes:**

- The detection happens at projection-open time; `dome sync`, `dome serve`, and the harness operational path rebuild before stale projection rows can drive in-sync work.
- The harness scenario `tests/harness/scenarios/cli-surface/sync-rebuilds-stale-projections.scenario.test.ts` exercises the cache-key drift rebuild path.
- A processor that *forgets* to bump its version when its emission shape changed is a bug in the processor author's release process, not in the engine. The engine treats `(processor_id, version)` as the cache key; same key = same emissions, by contract.

**Related:**
- [[wiki/specs/projection-store]] §"Cache key"
- [[wiki/specs/processors]] §"Idempotency"
- [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]]
- [[wiki/gotchas/projection-schema-skew]]
- [[wiki/gotchas/processor-idempotency]]
