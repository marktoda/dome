# Auto-resolution Audit Trail + Enablement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable `answered_by` (`'owner' | 'auto'`) audit trail to question answers (migrated in place on existing vaults), then enable auto-resolution in the shipped vault-config template (engine default stays OFF).

**Architecture:** `answers.db` gains an `answered_by` column via the outbox-style `tryMigrate` (frozen prior-hash constant + `ALTER TABLE ADD COLUMN` guard + transaction). The actor threads through the single shared chokepoint `answerQuestionDurably` — `vault.resolve` passes `'owner'`, `runQuestionAutoResolution` passes `'auto'` — and mirrors into the rebuildable projection row (populated on answer and on rebuild rehydration). Surfacing is quiet: the resolve display and `inspect questions` show the actor; no per-answer diagnostic. Enablement is copy-only: the commented `auto_resolve_questions` template block goes live with `enabled: true`.

**Tech Stack:** TypeScript on Bun; `bun:sqlite`; `bun test`.

## Global Constraints

- `answered_by` values are exactly the strings `'owner'` and `'auto'`; column is `TEXT NOT NULL DEFAULT 'owner'` in `question_answers` (durable) and mirrored on the projection `questions` table.
- `answers.db` migration: `{kind: "migrate"}` accepting ONLY the frozen prior schema hash (captured from `computeAnswersSchemaHash()` BEFORE the DDL edit); any other stored hash still refuses. Mirror `src/outbox/db.ts:255-300` (column-exists guard, `BEGIN`/`COMMIT`, meta hash update handled by the seam).
- `DEFAULT_RUNTIME_CONFIG.engine.autoResolveQuestions.enabled` stays `false`. The `default-vault-config.ts` template block becomes live with `enabled: true`, `policies: ["agent-safe"]`, `min_confidence: 0.6`, `max_per_tick: 20`.
- No per-auto-answer diagnostic. No change to the auto-resolution gates (`risk === "low"`, confidence floor, recommendedAnswer∈options, sourceRef existence, maxPerTick).
- Typecheck gate: `bun run tsc --noEmit 2>&1 | grep -v "open-store.test.ts"` → zero new errors (the filtered line, if present, is pre-existing).

---

### Task 1: durable `answered_by`, migrated and threaded end-to-end

**Files:**
- Modify: `src/answers/db.ts`, `src/answers/question-answers.ts`, `src/engine/operational/question-answer-recording.ts`, `src/projections/questions.ts`, `src/vault.ts`, `src/engine/operational/question-auto-resolution.ts`, `src/engine/host/projection-rebuild.ts`, `src/engine/host/question-answering.ts` (if it passes through to `answerQuestionDurably`, thread `'owner'`)
- Test: `tests/answers/db.test.ts`, plus the existing question-answers / auto-resolution / recording test files (locate via `grep -rln "answerQuestionDurably\|recordQuestionAnswer\|runQuestionAutoResolution" tests/`)

**Interfaces:**
- Consumes: `openSimpleStore` migrate policy (`src/sqlite/open-store.ts:212-227`), outbox precedent (`src/outbox/db.ts:255-300`).
- Produces: `export type QuestionAnsweredBy = "owner" | "auto"` (export from `src/answers/question-answers.ts`); `recordQuestionAnswer(db, {…, answeredBy})`; `answerQuestionDurably({…, answeredBy})`; `applyQuestionAnswer(db, {…, answeredBy})`; `QuestionAnswerRecord.answeredBy` and projection `QuestionRecord.answeredBy: QuestionAnsweredBy | null` (null = unanswered).

- [ ] **Step 1: Capture the prior schema hash BEFORE touching the DDL**

Run: `bun -e 'import { computeAnswersSchemaHash } from "./src/answers/db"; console.log(computeAnswersSchemaHash())'`
Record the printed 64-hex value — it becomes the frozen constant in Step 3. Do this first; after the DDL edit the function returns the NEW hash.

- [ ] **Step 2: Write the failing migration + stamping tests**

In `tests/answers/db.test.ts` add (mirroring the file's existing tmpdir/open patterns):

```typescript
test("answered_by migration: an old-schema answers.db opens, migrates in place, and preserves rows as 'owner'", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "answers-migrate-")), "answers.db");
  // Build the OLD schema by hand: the pre-answered_by DDL + the frozen prior
  // hash in answers_meta (constant exported for tests as
  // ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY), plus one legacy row.
  const legacy = new Database(path, { create: true });
  legacy.run(OLD_QUESTION_ANSWERS_DDL); // the current-main CREATE TABLE, verbatim, without answered_by
  legacy.run("CREATE TABLE answers_meta (schema_hash TEXT NOT NULL PRIMARY KEY, built_at TEXT NOT NULL)");
  legacy.run("INSERT INTO answers_meta (schema_hash, built_at) VALUES (?, ?)", [ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY, "2026-01-01T00:00:00.000Z"]);
  legacy.run("INSERT INTO question_answers (idempotency_key, answer, answered_at, question_id, question, processor_id, adopted_commit) VALUES ('k1','yes','2026-06-01T00:00:00.000Z',1,'q?','p','c')");
  legacy.close();

  const result = await openAnswersDb({ path });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("open failed");
  expect(result.value.migration).toBe("migrated");
  const row = result.value.db.raw
    .query<{ answered_by: string }, []>("SELECT answered_by FROM question_answers WHERE idempotency_key = 'k1'")
    .get();
  expect(row?.answered_by).toBe("owner");
  result.value.db.close();
});

test("answered_by migration: an unknown stored hash still refuses", async () => {
  // Same construction but with schema_hash = 'deadbeef'; expect result.ok === false.
});
```

Define `OLD_QUESTION_ANSWERS_DDL` in the test as the verbatim current-main `CREATE TABLE question_answers (...)` string (copy from `src/answers/db.ts` before editing). Also add a stamping test to the question-answers test file:

```typescript
test("recordQuestionAnswer stores answered_by and query round-trips it", () => {
  const rec = recordQuestionAnswer(db, { ...baseOpts, answeredBy: "auto" });
  expect(rec.answeredBy).toBe("auto");
  expect(getQuestionAnswer(db, baseOpts.idempotencyKey)?.answeredBy).toBe("auto");
});
```

- [ ] **Step 3: Run the new tests to verify they fail** (missing export / missing column) — `bun test tests/answers/`

- [ ] **Step 4: Implement the answers.db schema + migration**

In `src/answers/db.ts`:
- Add to the `question_answers` CREATE TABLE (after `adopted_commit TEXT NOT NULL,`): `"answered_by TEXT NOT NULL DEFAULT 'owner',"` — keep it BEFORE the handler columns to match the shapes list order you choose; add `"answered_by"` to `REQUIRED_TABLE_SHAPES`.
- Add, near the top:

```typescript
/** Schema hash of answers.db before the answered_by column (2026-06-27). A
 * store carrying exactly this hash is upgraded in place; any other mismatch
 * still refuses (durable answers are unrebuildable). */
export const ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY =
  "<the value captured in Step 1>";
```

- Switch the open policy:

```typescript
    policy: {
      kind: "migrate",
      tryMigrate: (db, storedHash) => {
        if (storedHash !== ANSWERS_SCHEMA_HASH_BEFORE_ANSWERED_BY) return false;
        applyAnsweredByMigration(db);
        return true;
      },
    },
```

- Add the migration fn (mirror `applyNextAttemptAtMigration`):

```typescript
function applyAnsweredByMigration(db: Database): void {
  db.run("BEGIN");
  try {
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(question_answers)").all();
    if (!cols.some((c) => c.name === "answered_by")) {
      db.run("ALTER TABLE question_answers ADD COLUMN answered_by TEXT NOT NULL DEFAULT 'owner'");
    }
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}
```

- Widen `OpenAnswersDbResult.migration` to `"fresh" | "ok" | "migrated"` and stop collapsing it (delete the "REFUSE never yields" mapping; return the seam's value directly). Update the header comment (the store now migrates the one known prior hash).

- [ ] **Step 5: Thread the actor through writers and readers**

- `src/answers/question-answers.ts`: export `type QuestionAnsweredBy = "owner" | "auto"`; add `answeredBy` to `RecordQuestionAnswerOpts` + `QuestionAnswerRecord`; add the column to `UPSERT_SQL` (insert list, VALUES `?`, and `answered_by = excluded.answered_by` in the conflict set), `QUERY_ALL_SQL`, `QUERY_BY_KEY_SQL`, and the row→record mapping.
- `src/engine/operational/question-answer-recording.ts`: add `readonly answeredBy: QuestionAnsweredBy` to `AnswerQuestionDurablyOpts`; pass it to both `recordQuestionAnswer` and `applyQuestionAnswer`.
- `src/projections/questions.ts`: add `answered_by TEXT` to the projection questions DDL (nullable — null until answered) and to `QuestionRecord` as `answeredBy: "owner" | "auto" | null`; extend `ApplyQuestionAnswerOpts` + `APPLY_ANSWER_SQL` to set it. Note: projection.db is rebuildable — check `src/projections/db.ts`'s open policy and rely on its existing mismatch path (rebuild), adding no migration.
- `src/vault.ts` `resolveQuestion`: pass `answeredBy: "owner"`.
- `src/engine/host/question-answering.ts`: if it calls `answerQuestionDurably`, pass `answeredBy: "owner"` (it is a human/agent-client path).
- `src/engine/operational/question-auto-resolution.ts` (line ~120): pass `answeredBy: "auto"`.
- `src/engine/host/projection-rebuild.ts` `restoreDurableQuestionAnswers`: pass `answeredBy: answer.answeredBy` through to `applyQuestionAnswer`.

- [ ] **Step 6: Run tests + typecheck** — `bun test tests/answers/ $(grep -rln "answerQuestionDurably\|runQuestionAutoResolution" tests/ | tr '\n' ' ')` → PASS; typecheck gate → zero new errors. Existing auto-resolution tests should still pass with only the new required-param threading (update their fixtures where the compiler demands it — assert `'auto'` where natural).

- [ ] **Step 7: Commit**

```bash
git add -A src/answers src/engine src/projections/questions.ts src/vault.ts tests/
git commit -m "feat(answers): durable answered_by audit trail (owner|auto), migrated in place

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: quiet surfacing + template enablement

**Files:**
- Modify: `src/surface/answer.ts` (the `formatQuestion` display), `src/cli/commands/inspect-columns.ts` (QUESTIONS_COLUMNS / json), `src/cli/default-vault-config.ts`
- Test: `tests/cli/commands/inspect.test.ts`, the answer-command test file (locate via `grep -rln "formatQuestion\|runAnswer" tests/`), `tests/integration/default-vault-config.test.ts`

**Interfaces:**
- Consumes: `QuestionRecord.answeredBy` from Task 1.
- Produces: resolve/answer display line `answered by <owner|auto> at <ts>` for answered questions; `inspect questions --json` rows include `answered_by`; `dome init` config enables auto-resolution.

- [ ] **Step 1: Write the failing tests**

- Answer display: in the answer-command test file, an already-answered question's display output contains `answered by owner` (extend an existing already-answered fixture).
- Inspect: in `inspect.test.ts`, the questions subject `--json` row for an answered question includes `"answered_by": "owner"` (or `"auto"` per fixture).
- Config: in `tests/integration/default-vault-config.test.ts`, the generated default config parses and yields `engine.autoResolveQuestions.enabled === true` with policies `["agent-safe"]`, minConfidence `0.6`, maxPerTick `20`; and a separate assertion that `DEFAULT_RUNTIME_CONFIG.engine.autoResolveQuestions.enabled === false` (engine built-in unchanged).

- [ ] **Step 2: Run to verify RED**, then implement:

- `src/surface/answer.ts`: where the answered state renders (`answered_at`/answer line), append the actor: `answered by ${record.answeredBy ?? "owner"}`.
- `src/cli/commands/inspect-columns.ts`: include `answered_by` in the questions row object so `--json` carries it; text mode unchanged (the existing hint already says full fields are json-only).
- `src/cli/default-vault-config.ts`: replace the commented block with a live one (keep the explanatory comment above it):

```yaml
  # Low-risk question auto-resolution. Dome answers unresolved questions that
  # declare low risk, an allowed automation policy, sufficient confidence, and
  # a recommended answer valid for the question options. Answer handlers still
  # run through the normal garden / adoption path. Answers are stamped
  # answered_by: auto in answers.db. Set enabled: false to opt out.
  auto_resolve_questions:
    enabled: true
    policies:
      - "agent-safe"
    min_confidence: 0.6
    max_per_tick: 20
```

- [ ] **Step 3: Run tests + typecheck** — the three test files above + `bun test tests/cli/commands/check.test.ts` (guards the check surface didn't shift) → PASS; typecheck gate → zero new errors.

- [ ] **Step 4: Commit**

```bash
git add src/surface/answer.ts src/cli/commands/inspect-columns.ts src/cli/default-vault-config.ts tests/
git commit -m "feat(config): enable agent-safe auto-resolution in the vault template; surface answered_by

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** migration + refuse-on-unknown (T1 S2/S4) ✓; actor threading through the single chokepoint incl. rehydration (T1 S5) ✓; quiet surfacing (T2) ✓; template ON / engine default OFF (T2 S1/S2) ✓; work-vault enablement is post-merge operational (spec) — not a plan task ✓; no gate changes, no diagnostics ✓.

**Placeholder scan:** One deliberate placeholder: `<the value captured in Step 1>` — it CANNOT be known until Step 1 runs (the hash of the current DDL); the step that produces it is explicit and first. Test-file locations use one guarded grep each where the exact filename isn't pinned; assertions are given concretely.

**Type consistency:** `QuestionAnsweredBy = "owner" | "auto"` defined once in `question-answers.ts`, consumed by recording, projection (`| null` for unanswered), vault, auto-resolution, rebuild. `migration: "fresh" | "ok" | "migrated"` matches the seam's `SimpleMigration`.
