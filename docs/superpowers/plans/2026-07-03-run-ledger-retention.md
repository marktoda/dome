# Run-Ledger Retention — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make run-ledger pruning safe by construction (two supersession guards), wire `ledger.retention_days`, auto-prune daily in `dome serve`, and add a doctor size probe — so a 2.7GB runs.db ENOSPC never recurs.

**Architecture:** Extend the shared `RETENTION_ELIGIBLE_RUN_WHERE_SQL` fragment (every plan/count/delete statement interpolates it, so the CLI inherits the fix). Add a `ledger` section to `RuntimeConfig` (strict parse, like the sibling `engine:` sections). `serve.ts` gets a `nextLedgerGcAtMs` clock beside `nextOperationalAtMs`: first tick + every 24h in-process, calling `pruneRunLedger` (never VACUUM). A health-registry finding warns on oversized runs.db.

**Tech Stack:** TypeScript on Bun; `bun:sqlite`; `bun test`.

## Global Constraints

- Eligibility keeps today's base (terminal + `succeeded`, or `skipped` with `error IS NULL`, older than cutoff) AND adds: a newer same-processor run must exist; if the row is `trigger_kind='schedule'`, a newer same-processor schedule-triggered run must exist. Failed/timed_out/cancelled/queued/running rows stay never-pruned.
- `ledger.retention_days`: positive integer or absent. Absent → retain forever (engine default). Malformed → config parse error (strict, like `engine:`). Template ships `retention_days: 30`.
- Auto path never VACUUMs. Daemon-only (serve loop); `dome sync` does not prune.
- Doctor probe threshold: 512 MB (constant), severity `warning`, message includes the file size and both remedies (`ledger.retention_days`; `dome repair run-ledger --apply --vacuum`).
- Typecheck gate: `bun run tsc --noEmit 2>&1 | grep -v "open-store.test.ts"` → zero new errors.

---

### Task 1: supersession guards in the eligibility predicate

**Files:**
- Modify: `src/ledger/runs.ts` (the `RETENTION_ELIGIBLE_RUN_WHERE_SQL` constant, ~line 568, and its doc comment)
- Test: the existing ledger runs test file (locate: `grep -rln "pruneRunLedger\|planRunLedgerRetention" tests/` — expected `tests/ledger/runs.test.ts`)

**Interfaces:**
- Consumes: existing `planRunLedgerRetention`/`pruneRunLedger` (unchanged signatures).
- Produces: the hardened WHERE fragment used verbatim by all seven interpolating statements (counts, sums, bounds, status-counts, both DELETEs).

- [ ] **Step 1: Write the failing predicate tests**

In the ledger runs test file, using its existing helpers for opening a temp ledger and inserting runs (mirror how current retention tests build rows — find the existing `planRunLedgerRetention`/`pruneRunLedger` tests and their row-insertion helpers; reuse them):

```typescript
test("retention never deletes a processor's newest run, even when old and succeeded", () => {
  // one processor, ONE old succeeded run (its newest) → not eligible
  // insert run A (processor p1, succeeded, started 100 days ago)
  const plan = planRunLedgerRetention(db, { cutoffIso: daysAgoIso(30) });
  expect(plan.eligibleRuns).toBe(0);
});

test("an old succeeded run superseded by a newer run IS eligible", () => {
  // p1: run A (100 days ago, succeeded) + run B (1 day ago, succeeded)
  // cutoff 30d → A eligible, B not (B is newest)
  const plan = planRunLedgerRetention(db, { cutoffIso: daysAgoIso(30) });
  expect(plan.eligibleRuns).toBe(1);
});

test("retention never deletes a processor's newest schedule-triggered run", () => {
  // p1: schedule run A (100 days ago, succeeded) + NON-schedule run B (1 day ago)
  // A is superseded as a run, but is the newest SCHEDULE run → not eligible
  const plan = planRunLedgerRetention(db, { cutoffIso: daysAgoIso(30) });
  expect(plan.eligibleRuns).toBe(0);
});

test("an old schedule run with a NEWER schedule run is eligible", () => {
  // p1: schedule run A (100 days ago) + schedule run B (1 day ago), both succeeded
  const plan = planRunLedgerRetention(db, { cutoffIso: daysAgoIso(30) });
  expect(plan.eligibleRuns).toBe(1);
  const result = pruneRunLedger(db, { cutoffIso: daysAgoIso(30) });
  expect(result.prunedRuns).toBe(1);
  // A's capability_uses rows went with it; B's remain (insert one per run in setup)
});

test("failed and running rows remain ineligible regardless of supersession", () => {
  // p1: failed run (100 days ago) + succeeded run (1 day ago) → 0 eligible
});
```

Match the file's existing insertion helper signatures exactly (trigger_kind is settable — the current writers set it; if the helper doesn't expose trigger_kind, extend the test-local helper, not production code).

- [ ] **Step 2: Run to verify RED** — `bun test <ledger test file>`: the newest-run and newest-schedule-run tests fail (current predicate marks them eligible).

- [ ] **Step 3: Implement the hardened fragment**

Replace `RETENTION_ELIGIBLE_RUN_WHERE_SQL` with:

```typescript
// Retention deliberately prunes only boring terminal rows. Failed, timed_out,
// cancelled, queued, running, and reason-bearing skipped rows keep their audit
// value until an operator explicitly decides otherwise in a future wider tool.
//
// Two supersession guards make pruning safe by construction:
//   - a processor's NEWEST run is never eligible: `latestActiveProblemRuns`
//     suppresses old failures only while a newer same-processor run exists,
//     so deleting the newest success would resurface resolved failures.
//   - a processor's newest SCHEDULE-triggered run is never eligible: after a
//     projection rebuild the scheduler recovers last-fire times from the
//     ledger (`latestScheduleRunStartedAt`); deleting it re-fires the job
//     (the 2026-06-10 "consolidate re-charged 11x" incident class).
const RETENTION_ELIGIBLE_RUN_WHERE_SQL = `
finished_at IS NOT NULL
  AND started_at < ?
  AND (
    status = 'succeeded'
    OR (status = 'skipped' AND error IS NULL)
  )
  AND EXISTS (
    SELECT 1 FROM runs newer
    WHERE newer.processor_id = runs.processor_id
      AND newer.started_at > runs.started_at
  )
  AND (
    runs.trigger_kind != 'schedule'
    OR EXISTS (
      SELECT 1 FROM runs newer_schedule
      WHERE newer_schedule.processor_id = runs.processor_id
        AND newer_schedule.trigger_kind = 'schedule'
        AND newer_schedule.started_at > runs.started_at
    )
  )
`.trim();
```

Note: the fragment is interpolated both directly (`FROM runs WHERE …`) and inside `run_id IN (SELECT id FROM runs WHERE …)` — the unqualified `runs.` references bind to the enclosing SELECT/DELETE's `runs` table in both shapes; the `newer`/`newer_schedule` aliases disambiguate the correlated scans (served by `runs_by_processor`).

- [ ] **Step 4: GREEN + typecheck** — ledger tests pass; also run `bun test tests/cli/commands/repair.test.ts` if it exists (`grep -rln "run-ledger" tests/cli/`) since the CLI inherits the predicate; typecheck gate clean.

- [ ] **Step 5: Commit**

```bash
git add src/ledger/runs.ts tests/ledger/
git commit -m "fix(ledger): retention never prunes a processor's newest run or newest schedule run

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `ledger.retention_days` config + daemon auto-prune

**Files:**
- Modify: `src/engine/core/capability-policy.ts` (RuntimeConfig + parser + DEFAULT_RUNTIME_CONFIG), `src/cli/commands/serve.ts`, `src/ledger/runs.ts` (one small exported helper)
- Test: the capability-policy config test file (`grep -rln "parseRuntimeConfig\|DEFAULT_RUNTIME_CONFIG" tests/ | head`), `tests/cli/serve.test.ts`

**Interfaces:**
- Consumes: Task 1's hardened `pruneRunLedger`.
- Produces: `RuntimeConfig.ledger: { readonly retentionDays?: number }`; `runLedgerRetentionPass({ ledger, retentionDays, now? }): PruneRunLedgerResult` exported from `src/ledger/runs.ts` (computes `cutoffIso = now - retentionDays*DAY_MS`, calls `pruneRunLedger` with `vacuum: false`).

- [ ] **Step 1: Failing config tests** — in the capability-policy test file: `ledger: { retention_days: 30 }` parses to `config.ledger.retentionDays === 30`; absent `ledger:` → `retentionDays` undefined; `retention_days: 0` / `-1` / `"x"` → parse error (strict); `DEFAULT_RUNTIME_CONFIG.ledger` has no retention. Run → RED (unknown key / missing field).

- [ ] **Step 2: Implement config** — add to `RuntimeConfig`: `readonly ledger: { readonly retentionDays?: number };`. In `DEFAULT_RUNTIME_CONFIG`: `ledger: Object.freeze({})`. Add `parseLedgerConfig(raw)` mirroring the sibling section parsers (accept only key `retention_days`, positive integer; unknown keys rejected the same way `engine:` handles its keys — read the file's existing pattern and match it exactly), wire it where `git:`/`engine:` sections are parsed. GREEN.

- [ ] **Step 3: Failing serve test** — in `tests/cli/serve.test.ts`, mirroring the existing `runServe` fixture pattern (generous 250ms intervals per the file's dirty-defer test): build a fixture whose config sets `ledger: { retention_days: 30 }`, pre-insert into the fixture's runs.db two succeeded runs for one processor with `started_at` 100 and 90 days ago plus one recent run (so exactly the two old ones are eligible... note: with the Task-1 guards, the 90-day row is eligible only if a newer run exists — the recent run provides it; the 100-day row too; expected pruned = 2). Open the ledger directly after `waitFor` adoption settles + one operational interval, and assert the old rows are gone and the recent row remains. Also assert a second interval does NOT error (the 24h gate simply doesn't re-fire — observable as no additional log/no crash; keep the assertion to row-state, not timing). Run → RED.

- [ ] **Step 4: Implement the daemon pass** — in `src/ledger/runs.ts` add:

```typescript
const DAY_MS = 24 * 60 * 60 * 1000;

/** One automatic retention pass: prune rows older than `retentionDays`
 * using the hardened eligibility predicate. Never VACUUMs — freed pages
 * recycle in place; explicit reclamation stays with
 * `dome repair run-ledger --apply --vacuum`. */
export function runLedgerRetentionPass(opts: {
  readonly ledger: LedgerDb;
  readonly retentionDays: number;
  readonly now?: () => Date;
}): PruneRunLedgerResult {
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  const cutoffIso = new Date(nowMs - opts.retentionDays * DAY_MS).toISOString();
  return pruneRunLedger(opts.ledger, { cutoffIso, vacuum: false });
}
```

(If `DAY_MS` already exists in the file, reuse it.) In `src/cli/commands/serve.ts`, beside `let nextOperationalAtMs = 0;` add `let nextLedgerGcAtMs = 0;`. Inside the `drift.kind === "drift" || "in-sync"` branch, AFTER the tick call (so it never delays adoption), add:

```typescript
      // Daily run-ledger retention (daemon-only; dome sync never prunes).
      // In-process cadence: first pass on startup's first workable tick,
      // then every 24h — no persisted state (a restart pruning once more is
      // an idempotent no-op when nothing is eligible). Never VACUUMs.
      const retentionDays = runtime.config.ledger.retentionDays;
      if (retentionDays !== undefined && nowMs >= nextLedgerGcAtMs) {
        nextLedgerGcAtMs = nowMs + 24 * 60 * 60 * 1000;
        try {
          const pruned = runLedgerRetentionPass({ ledger: runtime.ledgerDb, retentionDays });
          if (!quiet && pruned.prunedRuns > 0) {
            console.error(
              `dome serve: run-ledger retention pruned ${pruned.prunedRuns} runs (+${pruned.prunedCapabilityUses} capability uses) older than ${retentionDays}d`,
            );
          }
        } catch (e) {
          if (!quiet) {
            console.error(`dome serve: run-ledger retention failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
```

Check how serve accesses the runtime's ledger (`runtime.ledgerDb` — verify the property name on `VaultRuntime` and adjust). GREEN + typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/engine/core/capability-policy.ts src/cli/commands/serve.ts src/ledger/runs.ts tests/
git commit -m "feat(ledger): wire ledger.retention_days; serve auto-prunes daily (no VACUUM)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: doctor size probe + template + spec doc

**Files:**
- Modify: `src/engine/host/health/registry.ts` (or the module where operational-store findings live — follow `operationalSchemaFinding`'s home), `src/cli/default-vault-config.ts`, `docs/wiki/specs/run-ledger.md`
- Test: the health/doctor test files used by the schema-probe tests (`tests/engine/health-operational-schema.test.ts` neighbors / `tests/cli/commands/doctor.test.ts`), `tests/integration/default-vault-config.test.ts`

**Interfaces:**
- Consumes: nothing new (statSync on `<vault>/.dome/state/runs.db`, following the registry's existing `statSync` try/catch pattern).
- Produces: a `warning` finding (code e.g. `ledger.oversized`, threshold constant `LEDGER_SIZE_WARNING_BYTES = 512 * 1024 * 1024`) whose message names the actual size in MB and both remedies; no finding below threshold or when the file is absent. Template config gains the live `ledger:` block.

- [ ] **Step 1: Failing tests** — health finding: file above threshold → one warning finding whose message contains the size, `ledger.retention_days`, and `dome repair run-ledger --apply --vacuum`; below threshold → none; missing file → none. (Follow how the schema-probe findings are unit-tested — inject the size or point at a temp file; prefer injecting a `fileSizeBytes` input over real 512MB files.) Config test: generated default config parses with `ledger.retentionDays === 30`. RED.

- [ ] **Step 2: Implement** — the finding function beside its operational siblings, sized via `statSync(join(vaultPath, ".dome/state/runs.db")).size` in a try/catch (absent → no finding), wired into the registry list; the template block in `default-vault-config.ts`:

```yaml
ledger:
  # Prune succeeded/no-op run-ledger rows older than this many days. Audit
  # rows for failures, timeouts, and each processor's newest runs are always
  # kept. Comment out to retain forever; reclaim disk with
  # `dome repair run-ledger --apply --vacuum`.
  retention_days: 30
```

Update `docs/wiki/specs/run-ledger.md` §Retention: the knob is wired; `dome serve` prunes daily when set (first workable tick + every 24h, no VACUUM); eligibility now always preserves each processor's newest run and newest schedule-triggered run; default remains forever; `dome init` ships 30; bump `updated:` frontmatter to 2026-07-03. GREEN + typecheck.

- [ ] **Step 3: Scoped sweep + commit**

Run: `bun test tests/ledger tests/cli/serve.test.ts tests/cli/commands/doctor.test.ts tests/integration/default-vault-config.test.ts tests/integration/invariant-coverage.test.ts` → PASS.

```bash
git add src/engine/host/health src/cli/default-vault-config.ts docs/wiki/specs/run-ledger.md tests/
git commit -m "feat(doctor): warn on oversized runs.db; ship ledger retention in the vault template

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** guards (T1) ✓; knob wired end-to-end + daemon pass, sync excluded, no auto-VACUUM (T2) ✓; doctor probe + template + spec doc (T3) ✓; one-time work-vault reclaim is post-merge operational (spec) ✓; out-of-scope items untouched ✓.

**Placeholder scan:** test snippets carry their intent as comments where the file's local helpers must be reused (insertion-helper signatures unknown until read) — each such step names the exact grep to find the pattern to mirror. The serve-loop snippet flags the one property name to verify (`runtime.ledgerDb`).

**Type consistency:** `runLedgerRetentionPass` consumes `LedgerDb` + returns `PruneRunLedgerResult` (both existing exports); `RuntimeConfig.ledger.retentionDays?: number` matches the parser and the serve read; threshold constant named once.
