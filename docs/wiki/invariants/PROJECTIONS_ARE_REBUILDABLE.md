---
type: invariant
created: 2026-05-27
updated: 2026-06-10
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
tier: axiom
---

# PROJECTIONS_ARE_REBUILDABLE

**Tier:** Axiom — non-disable-able.

**Statement:** The knowledge projection rows in `<vault>/.dome/state/projection.db` can be reconstructed by walking the adopted commit and re-running the relevant deterministic processors, then rehydrating durable human answers from `answers.db`. Wiping `projection.db` and running `dome rebuild` restores facts, diagnostics, search rows, and rebuild-eligible questions modulo timestamps. Volatile projection-local queues/cursors (`scheduled_jobs`, `schedule_cursors`) reset during rebuild by design. Answers (`answers.db`), the outbox (`outbox.db`), the run ledger (`runs.db`), and quarantine state are NOT covered by this invariant — they hold human decisions, retry state, recovery state, and history that cannot be derived from markdown.

**Why:** This is the structural guarantee that makes [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] concrete for the projection layer. SQLite gives the engine fast queries; markdown remains the durable source. If the projection becomes corrupt, the user wipes and rebuilds — no data loss, no migration tooling required.

The invariant also lets the engine handle schema migrations cheaply: when the SDK version bumps and the schema hash changes, the engine wipes + rebuilds automatically without prompting. The user sees a "rebuilding..." message; the operation is correct by construction.

**Structural enforcement:**

1. **`dome rebuild` is the rebuild path.** `src/engine/host/projection-rebuild.ts` is the function; CLI surface is `dome rebuild`. The rebuild is idempotent for persisted knowledge rows — running it twice in succession produces equivalent projection content modulo `written_at` timestamps and deliberately reset operational queues/cursors.
2. **Every persisted knowledge projection has a deterministic rebuild source.** `facts` from running adoption-phase processors plus explicitly deterministic, projection-safe garden emitters against the adopted commit. `fts_documents` from re-indexing markdown bodies. `diagnostics` from re-running validation processors. `questions` from rebuild-eligible `QuestionEffect` emitters, with durable answers reapplied from `answers.db`. `scheduled_jobs` and `schedule_cursors` are projection-local operational rows, not knowledge projections: rebuild intentionally drops pending jobs and resets schedule cursors so due work is reconsidered by the normal operational pump. This is by design: projection re-derivation preserves adopted-state knowledge and avoids replaying side effects or stale in-flight work.
3. **The schema-version check is automatic.** On `openVault`, the engine computes the schema-hash from the SDK's projection schema and compares to `projection_meta.schema_hash`. Mismatch → automatic rebuild.
4. **Nothing writes to `projection.db` from outside `src/projections/`.** Per [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]] — the projections directory is the SQLite-writing boundary, parallel to the engine's git-writing boundary.

**Counter-example:** A processor emits a `FactEffect` that "extracts" a claim purely from its own internal state — not from any vault content. The fact lands in `projection.db.facts`. The user wipes `projection.db` and runs `dome rebuild`; the same processor re-runs against the same adopted commit and emits the same effect (idempotency), the same fact lands in the table. Idempotent processors + deterministic input = rebuildable projections. A processor that emits non-idempotent facts (e.g., a UUID for each invocation) violates [[wiki/specs/processors]] §"Idempotency" and breaks this invariant; the fix is in the processor, not in the projection.

**Test guarantee:** `tests/invariants/projections-are-rebuildable.test.ts` pins the invariant doc into the AC3 lockstep surface. The high-level rebuild behavior is exercised by the `tests/harness/scenarios/cli-surface/` coverage: wipe projection rows, run `dome rebuild`, and assert diagnostics/facts/search rows are restored from adopted state without touching the run ledger or outbox.

**Related:**
- [[wiki/specs/projection-store]] §"Rebuild path"
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — the parent property
- [[wiki/gotchas/projection-schema-skew]] — automatic rebuild on schema mismatch
- [[wiki/gotchas/processor-version-drift]] — invalidation on processor version bump
