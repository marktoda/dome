# Task 1 report — Dedupe-hit refresh (stale-pending wedge)

## What changed

- `src/proposals/pending-proposals.ts`
  - `EnqueuePendingProposalResult` widened to `{ inserted: boolean; refreshed: boolean; id: number | null }`.
  - `enqueuePendingProposal` rewritten to run inside `db.raw.transaction(...)`:
    1. Attempt `INSERT OR IGNORE` (unchanged SQL). Success → `{inserted:true, refreshed:false, id}`.
    2. On dedupe-hit, `SELECT id, status FROM pending_proposals WHERE dedupe_key = ?` (new `SELECT_ID_STATUS_BY_DEDUPE_KEY_SQL`, replacing the old id-only select).
    3. If the existing row's `status !== 'pending'` → `{inserted:false, refreshed:false, id}` (applied/rejected rows stay untouched — unchanged "stays decided" behavior).
    4. If `status === 'pending'` → run new `REFRESH_BASE_SQL`: `UPDATE pending_proposals SET base_contents_json = ?, base_commit = ?, created_at = created_at WHERE id = ? AND status = 'pending'` with the **new** input's `baseContents`/`baseCommit`, then return `{inserted:false, refreshed:true, id}`. `changes_json`, `dedupe_key`, and `created_at` are never touched, per spec.
  - Module header comment extended with a paragraph explaining the refresh rationale (re-emission after the owner edited the file means "these changes against today's base").
  - Docstring on `enqueuePendingProposal` updated to describe the three-way branch.

- `src/engine/core/apply-effect.ts`
  - `ApplyEffectSinks.enqueueProposal`'s declared return type widened to `{ inserted: boolean; refreshed: boolean; id: number | null }` to match the store API — this was **not** in the task's file list but was required: `sinks.ts`'s `enqueueProposal` sink is contextually typed against this interface, so without widening it here, callers (e.g. the sinks test) could not observe `.refreshed` and `bun run typecheck` failed. Doc comment updated accordingly.
  - Fixed three sink-mock literals in `tests/engine/apply-effect.test.ts` that returned `{inserted, id}` without `refreshed` (added `refreshed: false` to each) — required by the widened interface, unrelated in intent but mechanically necessary for the full-repo typecheck gate.

- `src/projections/sinks.ts`: **no changes**. Verified: `enqueueProposal`'s body returns `enqueuePendingProposal(...)`'s result directly and only branches on `result.inserted` to fire `onProposalsChanged` — this is structurally already correct under the widened type (a refresh has `inserted: false`, so it does not fire the signal). Confirmed via the extended sinks test.

- Tests added/extended:
  - `tests/proposals/pending-proposals.test.ts`: two new cases —
    - re-enqueuing identical `(processorId, changes)` against a pending row with different `baseContents`/`baseCommit` → `refreshed:true`, same `id`, `getProposal` shows the new base, `createdAt`/`status`/`changes` untouched.
    - re-enqueuing against a rejected row → `{inserted:false, refreshed:false}`, `baseContents` unchanged.
  - `tests/projections/sinks.test.ts`: extended the existing "fires onProposalsChanged only on a fresh insert, not on a dedupe-hit re-enqueue" test with explicit `refreshed` assertions (`first.refreshed === false`, `second.refreshed === true`), confirming the callback still fires exactly once total.

## Verification

- `bun run typecheck` — clean (all three tsconfig projects).
- `bun test tests/proposals/pending-proposals.test.ts tests/projections/sinks.test.ts` — 30 pass, 0 fail.
- `bun test tests/engine/apply-effect.test.ts` (not part of the required gate, run as a courtesy check on the widened `ApplyEffectSinks` type) — 44 pass, 0 fail.

## Concerns / notes for reviewers

- The plan's file list for this task did not mention `src/engine/core/apply-effect.ts`, but widening `enqueuePendingProposal`'s return type transitively required widening `ApplyEffectSinks["enqueueProposal"]`'s declared return type (and fixing three test-mock literals), otherwise the full-repo `bun run typecheck` gate fails. This is the minimal change needed to keep the interface honest end-to-end; no behavioral change to `apply-effect.ts` itself (`queueGardenProposal` only reads `.id`, never `.inserted`/`.refreshed`).
- `REFRESH_BASE_SQL` intentionally keeps the `WHERE status = 'pending'` guard even though it's called from inside the same transaction right after confirming `status === 'pending'` — this is defense in depth (CAS-shaped, consistent with `DECIDE_SQL`'s style) rather than a correctness requirement given the transaction, but costs nothing and matches house style.
