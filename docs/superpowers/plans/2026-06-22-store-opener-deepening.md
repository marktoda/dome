# Store-Opener Deepening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the ~7-step store-opening choreography that is hand-wired across all four SQLite stores (`projection.db`, `runs.db`, `outbox.db`, `answers.db`) into one deep shared seam, without changing any store's observable open behavior. The genuinely-shared file/connection/hash prefix becomes `prepareStore`; the three durable-log stores additionally share `openSimpleStore` (policy → apply DDL → shapes → meta → classify); the projection cache keeps its bespoke cache-invalidation tail on top of the shared prefix.

**Architecture:** This was grilled to the following decisions ([[philosophy]] house style — depth as the test of a seam, locality > centralization, generalize-at-N=1 only when strictly cleaner/safer):

| Decision | Resolution |
|---|---|
| **Seam scope** | All four stores route through `prepareStore`. The three durable-log stores (`ledger`, `outbox`, `answers`) also share `openSimpleStore`. `projections` keeps its cache-key / WIPE / 4-state tail inline — that difference is *essential* (rebuildable cache vs. durable log), not accidental. |
| **The cut** | `prepareStore` is **prefix-only**: ensure-dir → open + configure → read stored hash → compute current hash → derive hash-only `isFresh`/`isSchemaChanged`. It closes `raw` on its own failures. The finish (per store) owns policy → `applyDdl` → shapes → meta → classify, and its own close-on-error. `prepareStore` applies **no DDL** (so refuse can abort and wipe can DROP *before* the schema lands). |
| **Error type** | Layered + shared. `PrepareStoreError = directory-create-failed \| schema-init-failed`; `StoreOpenError = PrepareStoreError \| schema-mismatch`. Simple stores alias their public error name to `StoreOpenError`; `projections` aliases to `PrepareStoreError` (it never refuses → never returns `schema-mismatch`). Zero caller churn — `vault-runtime` only reads `.error.kind` as an opaque string. |
| **Meta write** | One mechanic in `openSimpleStore`: `DELETE FROM <meta>; INSERT (schema_hash, built_at)` in a transaction. The robust superset of today's three mechanics — correct when the hash *changes* (additive migration), where `INSERT OR REPLACE` would orphan the old-hash row. |
| **Policy** | Required discriminated union: `{ kind: "refuse" } \| { kind: "migrate"; tryMigrate(db, storedHash): boolean }`. Refuse is named, never implied; migration of unrebuildable rows is a deliberate, visible opt-in. `tryMigrate` returns `true` = handled (→ `migrated`) / `false` = → refuse. Each store's prior-hash knowledge stays local to its `tryMigrate`. |
| **Foreign keys** | `prepareStore` takes `foreignKeys?: boolean` (default `false`). Only `ledger` passes `true` (for `capability_uses → runs`). Keeps all connection config in one place. |
| **Tests** | The existing per-store opener tests are the **immovable behavioral guard** — they test through the unchanged public `openXxxDb` interface and must stay green *verbatim*. New `tests/sqlite/open-store.test.ts` gives `prepareStore` + `openSimpleStore` first-class coverage (the shared leaves have none today). |

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, the four-concept Dome engine.

## Global Constraints

- **Canonical gate is the runtime suite:** `bun test ./tests` (NOT bare `bun test` — that sweeps `pwa/` without happy-dom). Full-repo `tsc` is pre-existing red; do not use it as a gate. Scope-run per task, then full-suite on the engine-touching tasks.
- **No observable behavior change.** Every store's public `openXxxDb` signature, success result (handle + `migration` value), and policy (WIPE / REFUSE / MIGRATE) is byte-for-byte preserved. The behavioral guard is the *unchanged* per-store opener tests. **If an existing opener test needs editing to stay green, STOP** — that means behavior drifted; fix the code, not the test.
- **One asterisk on "no behavior change" — call it out, don't hide it:** today the four stores disagree on the error *label* for a failed schema-hash read — `projections` returns `meta-read-failed`; the other three fold it into `schema-init-failed`. `prepareStore` unifies on `schema-init-failed`. This changes only an error *label* on a rare I/O failure (no control-flow change); `vault-runtime` surfaces it as an opaque `cause` string. If `tests/projections/db.test.ts` asserts the exact `meta-read-failed` kind, update *that assertion only*, with a comment citing this plan.
- **Mutation-fence:** `src/sqlite/open-store.ts` already calls `mkdirSync` (via `ensureParentDir`), so it is already accounted for in `tests/integration/no-direct-mutation-outside-boundaries.test.ts`. `prepareStore`/`openSimpleStore` add fs + sqlite writes *in the same file* → no new allow-list entry. Verify in the final task.
- **Public surface:** `tests/integration/public-surface-shape.test.ts` may pin exported error-type names. Aliasing (`export type LedgerDbError = StoreOpenError`) preserves the names; verify this test stays green.
- **Commit trailer:** end commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Tasks run in order. Task 1 is additive (nothing consumes the seam yet). Tasks 2–5 are file-disjoint (one `db.ts` each) and each ends green independently. Task 6 is the sweep.

## File structure

- `src/sqlite/open-store.ts` (MODIFY, Task 1) — add `PrepareStoreError`, `StoreOpenError`, `Prepared`, `prepareStore` (with `foreignKeys?`), `SimpleStorePolicy`, `SimpleStoreSpec`, `openSimpleStore`. Existing leaf helpers (`ensureParentDir`, `applyDdlInTransaction`, `readStoredSchemaHash`) stay.
- `tests/sqlite/open-store.test.ts` (NEW, Task 1).
- `src/ledger/db.ts` (MODIFY, Task 2) — `openLedgerDb` delegates to `openSimpleStore` (`refuse`, `foreignKeys: true`); `LedgerDbError = StoreOpenError`.
- `src/answers/db.ts` (MODIFY, Task 3) — `openAnswersDb` delegates (`refuse`); delete the private `.get()`-based `readStoredSchemaHash`; `AnswersDbError = StoreOpenError`.
- `src/outbox/db.ts` (MODIFY, Task 4) — `openOutboxDb` delegates (`migrate` wrapping `applyNextAttemptAtMigration`); `OutboxDbError = StoreOpenError`.
- `src/projections/db.ts` (MODIFY, Task 5) — `openProjectionDb` calls `prepareStore` for its prefix; keeps WIPE / cache-key / 4-state tail inline; `ProjectionDbError = PrepareStoreError`.
- Final sweep (Task 6) — delete superseded private helpers, run fences + full suite.

---

### Task 1: Build the shared prepare-seam in `src/sqlite/open-store.ts`

**Files:**
- Modify: `src/sqlite/open-store.ts`
- Create: `tests/sqlite/open-store.test.ts`

**Why:** The 7-step opener choreography is hand-wired in all four `db.ts` files; `open-store.ts` shares only the leaf calls, and its own header admits the per-store branching "stays in each store's opener." This task creates the deep shared module. It is purely additive — no store consumes it yet, so the full suite stays green.

**Interfaces (new exports):**

```typescript
import { Database } from "bun:sqlite";
import { configureSqliteConnection } from "./connection";
import { errorMessage } from "./error-message";
import { type Result, ok, err } from "../types";

/** Errors prepareStore (the prefix) can produce. */
export type PrepareStoreError =
  | { readonly kind: "directory-create-failed"; readonly path: string; readonly cause: string }
  | { readonly kind: "schema-init-failed"; readonly cause: string };

/** Errors a full simple-store open can produce: the prefix's, plus refusal. */
export type StoreOpenError =
  | PrepareStoreError
  | { readonly kind: "schema-mismatch"; readonly stored: string; readonly expected: string };

/** The prefix result: an open handle + the facts a finish needs to decide policy. */
export type Prepared = {
  readonly raw: Database;
  readonly storedHash: string | null; // null = fresh file (no meta table / no row)
  readonly currentHash: string;
  readonly isFresh: boolean;          // hash-only: storedHash === null
  readonly isSchemaChanged: boolean;  // hash-only: storedHash !== null && !== currentHash
};

export type PrepareStoreOpts = {
  readonly path: string;
  readonly metaTable: string;
  readonly currentHash: string;       // caller computes via computeDdlHash(DDL)
  readonly foreignKeys?: boolean;      // default false; ledger passes true
};

/**
 * The universal prefix every store opens through: ensure-dir → open + configure
 * (+ optional PRAGMA foreign_keys) → read stored hash → derive hash-only flags.
 * Applies NO DDL (so a finish can refuse/DROP before the schema lands). Closes
 * `raw` on its own failures; on success the caller owns the handle.
 */
export function prepareStore(opts: PrepareStoreOpts): Result<Prepared, PrepareStoreError>;

/** Durability policy for a durable-log store on schema-hash mismatch. */
export type SimpleStorePolicy =
  | { readonly kind: "refuse" }
  | { readonly kind: "migrate"; readonly tryMigrate: (db: Database, storedHash: string) => boolean };

export type SimpleStoreSpec = {
  readonly path: string;
  readonly metaTable: string;
  readonly ddl: ReadonlyArray<string>;
  readonly currentHash: string;
  readonly shapes: ReadonlyArray<SqliteTableShape>;
  readonly policy: SimpleStorePolicy;
  readonly foreignKeys?: boolean;
};

export type SimpleMigration = "fresh" | "ok" | "migrated";

export type SimpleStoreResult = {
  readonly raw: Database;       // caller wraps into its own frozen handle
  readonly schemaHash: string;
  readonly migration: SimpleMigration;
};

/**
 * The shared finish for durable-log stores: prepareStore → (on schema change)
 * consult policy → applyDdl (idempotent) → validate shapes → write the single
 * meta row (DELETE+INSERT in a tx) → classify migration. Owns close-on-error for
 * the whole tail. Returns the open raw handle + migration; the caller wraps the
 * raw into its own typed handle (preserving per-store handle shape).
 */
export function openSimpleStore(spec: SimpleStoreSpec): Result<SimpleStoreResult, StoreOpenError>;
```

Implementation notes for the body:
- `prepareStore`: mirror the existing step 1–3 of any opener. Reading the stored hash failing → `schema-init-failed` (the fold). On the `directory-create` failure return before opening; on open/configure/hash-read failure `raw.close()` then return err.
- `openSimpleStore` order: `prepareStore` → if `isSchemaChanged`: `refuse` → `raw.close()` + `err(schema-mismatch)`; `migrate` → `tryMigrate(raw, storedHash!)`; `false` → `raw.close()` + `err(schema-mismatch)`, `true` → mark `migrated`. Then `applyDdlInTransaction(raw, ddl)`; `validateSqliteTableShapes` (throw → caught → `raw.close()` + `schema-init-failed`); meta `DELETE+INSERT` in a tx; classify `isFresh ? "fresh" : migrated ? "migrated" : "ok"`.

- [ ] **Step 1: Write the failing test (`tests/sqlite/open-store.test.ts`).** Cover `prepareStore`: fresh file (no meta table → `isFresh`, `storedHash` null, `isSchemaChanged` false), matching existing meta (flags false), mismatched meta (`isSchemaChanged` true), `directory-create-failed` (point at an unwritable path), and that `raw` is closed on a post-open failure. Cover `openSimpleStore`: `refuse` on mismatch returns `schema-mismatch` + leaves file unmutated + handle closed; `migrate` with `tryMigrate → true` returns `migration: "migrated"`; `tryMigrate → false` returns `schema-mismatch`; fresh open returns `"fresh"` with exactly one meta row; re-open returns `"ok"`. Use a real temp dir (the SQLite boundary must hit real I/O).
- [ ] **Step 2: Run it, expect FAIL** — `bun test ./tests/sqlite/open-store.test.ts` (missing exports).
- [ ] **Step 3: Implement** the exports above in `src/sqlite/open-store.ts`.
- [ ] **Step 4: Run tests, expect PASS** — `bun test ./tests/sqlite/open-store.test.ts`, then `bun test ./tests` (additive change — everything still green).
- [ ] **Step 5: Commit** (`feat(sqlite): prepareStore + openSimpleStore — the shared store-opener seam`).

---

### Task 2: `openLedgerDb` delegates to `openSimpleStore`

**Files:** Modify `src/ledger/db.ts`. Guard: existing ledger opener tests (grep `openLedgerDb` / schema-mismatch in `tests/ledger/runs.test.ts`).

**Why:** Ledger is a durable log → `refuse` policy + `foreignKeys: true`. Its bespoke opener (`db.ts:327`), its private `insertOrReplaceMetaRow` (`:434`), and its `enableForeignKeys` (`:423`) collapse into a delegation.

- [ ] **Step 1: Confirm baseline green** — `bun test ./tests/ledger`.
- [ ] **Step 2: Rewrite `openLedgerDb`** to call `openSimpleStore({ path, metaTable: "ledger_meta", ddl: DDL, currentHash: computeLedgerSchemaHash(), shapes: REQUIRED_TABLE_SHAPES, policy: { kind: "refuse" }, foreignKeys: true })`, then wrap `result.value.raw` into the existing frozen `LedgerDb` (`{ raw, schemaHash, close }`) and map `migration` (`"migrated"` is unreachable under `refuse` → keep `LedgerMigration = "fresh" | "ok"`). Set `export type LedgerDbError = StoreOpenError`. Delete the now-dead private `insertOrReplaceMetaRow` and `enableForeignKeys`. Keep `computeLedgerSchemaHash`, the DDL, and `REQUIRED_TABLE_SHAPES`.
- [ ] **Step 3: Run, expect PASS with the ledger tests UNCHANGED** — `bun test ./tests/ledger ./tests/sqlite`, then `bun test ./tests`.
- [ ] **Step 4: Commit** (`refactor(ledger): openLedgerDb via the shared openSimpleStore seam`).

---

### Task 3: `openAnswersDb` delegates to `openSimpleStore`

**Files:** Modify `src/answers/db.ts`. Guard: `tests/answers/db.test.ts`.

**Why:** Answers is a durable log → `refuse`. It also carries a private `.get()`-based `readStoredSchemaHash` (`db.ts:166`) — exactly the divergent second copy the seam removes; it now goes through `prepareStore`'s shared reader.

- [ ] **Step 1: Confirm baseline green** — `bun test ./tests/answers`.
- [ ] **Step 2: Rewrite `openAnswersDb`** to call `openSimpleStore({ ..., metaTable: "answers_meta", policy: { kind: "refuse" } })`, wrap into the existing `AnswersDb` handle, map migration (`"fresh" | "ok"`). Delete the private `readStoredSchemaHash` (`:166`) and `insertOrReplaceMetaRow` (`:159`). Set `export type AnswersDbError = StoreOpenError`. Keep `computeAnswersSchemaHash`, DDL, shapes.
- [ ] **Step 3: Run, expect PASS, answers tests unchanged** — `bun test ./tests/answers ./tests/sqlite`, then `bun test ./tests`.
- [ ] **Step 4: Commit** (`refactor(answers): openAnswersDb via the shared seam; drop the divergent schema-hash reader`).

---

### Task 4: `openOutboxDb` delegates with a `migrate` policy

**Files:** Modify `src/outbox/db.ts`. Guard: outbox opener + migration tests (grep `openOutboxDb` / `next_attempt_at` / `migrated` in `tests/outbox/dispatch.test.ts`).

**Why:** Outbox is the one store with a realized additive migration. Its known-prior-hash check becomes a `tryMigrate` closure; `applyNextAttemptAtMigration` (`db.ts:375`) stays as outbox-local code the closure calls.

- [ ] **Step 1: Confirm baseline green, note the migration test** — `bun test ./tests/outbox`.
- [ ] **Step 2: Rewrite `openOutboxDb`** to call `openSimpleStore` with:
  ```typescript
  policy: {
    kind: "migrate",
    tryMigrate: (db, storedHash) => {
      if (storedHash !== OUTBOX_SCHEMA_HASH_BEFORE_NEXT_ATTEMPT_AT) return false;
      applyNextAttemptAtMigration(db);
      return true;
    },
  }
  ```
  Map `result.migration` to the existing `OutboxMigration` (`"fresh" | "ok" | "migrated"`). Keep `applyNextAttemptAtMigration`, `outboxColumnExists`, `OUTBOX_SCHEMA_HASH_BEFORE_NEXT_ATTEMPT_AT`, `OUTBOX_EPOCH_ISO`, DDL, shapes. Delete the private `insertOrReplaceMetaRow` (`:409`) — its DELETE+INSERT is now the shared mechanic. Set `export type OutboxDbError = StoreOpenError`.
- [ ] **Step 3: Run, expect PASS, the additive-migration test green and unchanged** — `bun test ./tests/outbox ./tests/sqlite`, then `bun test ./tests`.
- [ ] **Step 4: Commit** (`refactor(outbox): openOutboxDb via the shared seam; migration as a tryMigrate policy`).

---

### Task 5: `openProjectionDb` reuses `prepareStore` for its prefix

**Files:** Modify `src/projections/db.ts` (`openProjectionDb:578`). Guard: `tests/projections/db.test.ts`, `tests/projections/sinks.test.ts`.

**Why:** The projection cache keeps its essential tail (shape-drift detection, WIPE, cache-key invalidation, 4-state migration, full `meta` snapshot) — that difference is load-bearing (`PROJECTIONS_ARE_REBUILDABLE`). Only the shared *prefix* moves to `prepareStore`, de-conflating "open a sqlite file safely" from "is my projection cache stale."

- [ ] **Step 1: Confirm baseline green** — `bun test ./tests/projections`.
- [ ] **Step 2: Re-point the prefix.** Replace `openProjectionDb`'s step 1–3 (`ensureParentDir` + `new Database` + `configureSqliteConnection` + `readStoredSchemaHashFromTable`) with a `prepareStore({ path, metaTable: "projection_meta", currentHash: computeSchemaHash() })` call. From the returned `Prepared`, use `raw`, `storedHash`, `currentHash`. Keep `projectionStateExists` / `projectionSchemaShapeMatches` and compute projections' *richer* `isSchemaChanged` (`hash-mismatch OR (state-exists AND !shapeMatches)`) on top of the prefix facts — do **not** use `prepareStore`'s hash-only `isSchemaChanged`. The WIPE (DROP_DDL), cache-key meta read/write, 4-state classify, and `meta` snapshot stay inline.
- [ ] **Step 3: Error type.** `prepareStore` folds the failed-hash-read label into `schema-init-failed`. Set `export type ProjectionDbError = PrepareStoreError` (projections never returns `schema-mismatch` — it wipes). If `tests/projections/db.test.ts` asserts the old `meta-read-failed` kind on a hash-read failure, update *that one assertion* with a comment citing this plan (the single called-out label change).
- [ ] **Step 4: Run, expect PASS** — `bun test ./tests/projections ./tests/sqlite`, then `bun test ./tests` (engine core — full suite).
- [ ] **Step 5: Commit** (`refactor(projections): openProjectionDb reuses prepareStore for its prefix; cache tail stays local`).

---

### Task 6: Sweep — dead helpers, fences, full green

**Files:** Verify across `src/sqlite/open-store.ts`, the four `db.ts` files, the fence tests.

- [ ] **Step 1: Dead-helper sweep.** Confirm each store's private opener helpers superseded by the seam are deleted (no orphan `insertOrReplaceMetaRow`, `enableForeignKeys`, private `readStoredSchemaHash`). Grep `insertOrReplaceMetaRow` / `enableForeignKeys` under `src/{ledger,outbox,answers}` returns nothing.
- [ ] **Step 2: Fence checks.** `bun test ./tests/integration/no-direct-mutation-outside-boundaries.test.ts` (open-store.ts already accounted for — confirm green) and `bun test ./tests/integration/public-surface-shape.test.ts` (aliased error names preserved).
- [ ] **Step 3: Full suite** — `bun test ./tests`. All green; **no per-store opener test edited except the single Task-5 label assertion.**
- [ ] **Step 4: Line-count sanity** — confirm the four `db.ts` files shrank by the shared prefix (~40–50 lines each for the three simple stores; the prefix for projections) and `open-store.ts` grew by the seam. The net is the genuinely-duplicated ~160–200 lines collapsing to one place — not the inflated "~700" the first-pass review claimed (the per-store tails are essential and stay).
- [ ] **Step 5: Commit** (`chore(sqlite): sweep dead opener helpers; confirm fences after store-opener deepening`).

---

## Self-Review

**Scope coverage:** prepare-seam built (T1); three durable-log stores delegate (T2–T4); projection cache reuses the prefix only (T5); sweep (T6). All four route through `prepareStore`; the essential cache-vs-log difference stays visible and local to `projections`.

**No-behavior-change discipline:** the per-store opener tests are the guard and stay unedited — the single exception (projections' `meta-read-failed` → `schema-init-failed` label on a rare I/O failure) is called out in Global Constraints and Task 5, not smuggled. The meta-write mechanic change is observably equivalent (one row, current hash, refreshed `built_at`); a step verifies no test asserts the old SQL.

**Depth check:** `openSimpleStore`'s interface is a small spec object + one discriminated `policy` union — deep, not a config-bag. `prepareStore` is a 4-field prefix. The genericity is justified by three near-identical adapters (a real seam), and the one destructive path (WIPE) is *not* reachable through the shared simple-store entrypoint — it stays contained in `projections` (blast-radius containment).

**Type layering:** `PrepareStoreError ⊂ StoreOpenError`; simple stores alias `StoreOpenError`, projections aliases `PrepareStoreError` (precise — it can't refuse). Migration enums stay per-store; `"migrated"` never widens the two refuse stores' public type.

**Risk ranking:** T5 (projections, engine-core cache opener) and T1 (the new shared seam) are highest-risk → per-task review + full suite. T2–T4 are file-disjoint delegations guarded by unchanged tests → tests-green + diff check.
