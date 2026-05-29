---
type: invariant
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
tier: axiom
---

# PROJECTIONS_ARE_REBUILDABLE

**Tier:** Axiom — non-disable-able.

**Statement:** Anything in `<vault>/.dome/state/projection.db` can be reconstructed by walking the adopted commit and re-running the relevant processors, then rehydrating durable human answers from `answers.db`. Wiping `projection.db` and running `dome rebuild` produces a byte-equivalent (modulo timestamps) `.db` file. Answers (`answers.db`), the outbox (`outbox.db`), and the run ledger (`runs.db`) are NOT covered by this invariant — they hold human decisions and history that cannot be derived from markdown.

**Why:** This is the structural guarantee that makes [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] concrete for the projection layer. SQLite gives the engine fast queries; markdown remains the durable source. If the projection becomes corrupt, the user wipes and rebuilds — no data loss, no migration tooling required.

The invariant also lets the engine handle schema migrations cheaply: when the SDK version bumps and the schema hash changes, the engine wipes + rebuilds automatically without prompting. The user sees a "rebuilding..." message; the operation is correct by construction.

**Structural enforcement:**

1. **`dome rebuild` is the rebuild path.** `src/projections/rebuild.ts` is the function; CLI surface is `dome rebuild`. The rebuild is idempotent — running it twice in succession produces identical `.db` files modulo `written_at` timestamps.
2. **Every projection table has a deterministic rebuild source.** `facts` from running adoption-phase + garden-phase fact-emitters against the adopted commit. `fts_documents` from re-indexing markdown bodies. `diagnostics` from re-running validation processors. `questions`, `scheduled_jobs`, `schedule_cursors` are *partial* projections of state-during-runtime — `questions` and `scheduled_jobs` carry data the rebuild *intentionally drops* (asking a user a question once that they didn't answer; a job that was enqueued but never ran). `schedule_cursors` rebuild to "fire all cron processors on next sync" (the at-most-once-per-sync clamp from [[wiki/gotchas/scheduled-hook-idempotency]] absorbs the cost). This is by design: projection re-derivation prefers correctness-via-rebuild over preserving in-flight state.
3. **The schema-version check is automatic.** On `openVault`, the engine computes the schema-hash from the SDK's projection schema and compares to `projection_meta.schema_hash`. Mismatch → automatic rebuild.
4. **Nothing writes to `projection.db` from outside `src/projections/`.** Per [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]] — the projections directory is the SQLite-writing boundary, parallel to the engine's git-writing boundary.

**Counter-example:** A processor emits a `FactEffect` that "extracts" a claim purely from its own internal state — not from any vault content. The fact lands in `projection.db.facts`. The user wipes `projection.db` and runs `dome rebuild`; the same processor re-runs against the same adopted commit and emits the same effect (idempotency), the same fact lands in the table. Idempotent processors + deterministic input = rebuildable projections. A processor that emits non-idempotent facts (e.g., a UUID for each invocation) violates [[wiki/specs/processors]] §"Idempotency" and breaks this invariant; the fix is in the processor, not in the projection.

**Test guarantee:** `tests/invariants/projections-are-rebuildable.test.ts` — initializes a fixture vault, runs `dome sync` to populate `projection.db`, takes a snapshot of every table's contents, deletes `projection.db`, runs `dome rebuild`, asserts each table's contents match the snapshot (modulo `written_at` timestamps which are normalized in the comparison).

**Related:**
- [[wiki/specs/projection-store]] §"Rebuild path"
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — the parent property
- [[wiki/gotchas/projection-schema-skew]] — automatic rebuild on schema mismatch
- [[wiki/gotchas/processor-version-drift]] — invalidation on processor version bump
