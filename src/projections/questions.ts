// projection-questions: per-table accessor for QuestionEffect rows. Owns the
// QuestionEffect → `questions` row serialization and the row → QuestionEffect
// deserialization used by the Query API's `questions` surface.
//
// Normative references:
//   - docs/wiki/specs/projection-store.md §"Tables — questions"
//     (column shape + UNIQUE (idempotency_key))
//   - docs/wiki/specs/projection-store.md §"Query API" (read surface)
//
// House-style notes (matches src/projections/db.ts, src/projections/facts.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - JSON columns (`options_json`, `source_refs`) serialized via
//     `JSON.stringify`; symmetric `JSON.parse` on read.
//   - Row → QuestionEffect deserialization goes through `questionEffect`.
//   - Returned arrays are `Object.freeze`'d.
//   - INSERT uses `INSERT OR IGNORE` to honor the `idempotency_key UNIQUE`
//     constraint: a re-emission of the same key is a no-op.

import type { QuestionEffect } from "../core/effect";
import { questionEffect } from "../core/effect";
import type { CommitOid, SourceRef } from "../core/source-ref";
import type { ProjectionDb } from "./db";

// ----- Public types ---------------------------------------------------------

export type QuestionInsertOpts = {
  readonly effect: QuestionEffect;
  readonly processorId: string;
  readonly adoptedCommit: CommitOid;
};

export type QuestionsFilter = {
  readonly resolved?: boolean;
};

export type AnswerQuestionOpts = {
  readonly idempotencyKey: string;
  readonly answer: string;
};

// ----- SQL ------------------------------------------------------------------

const INSERT_QUESTION_SQL = `
INSERT OR IGNORE INTO questions (
  question, options_json, source_refs, idempotency_key,
  processor_id, adopted_commit, asked_at, answered_at, answer
) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
`.trim();

const QUERY_ALL_SQL = `
SELECT question, options_json, source_refs, idempotency_key
FROM questions
ORDER BY id
`.trim();

const QUERY_RESOLVED_SQL = `
SELECT question, options_json, source_refs, idempotency_key
FROM questions
WHERE answered_at IS NOT NULL
ORDER BY id
`.trim();

const QUERY_UNRESOLVED_SQL = `
SELECT question, options_json, source_refs, idempotency_key
FROM questions
WHERE answered_at IS NULL
ORDER BY id
`.trim();

const ANSWER_SQL = `
UPDATE questions
SET answer = ?, answered_at = ?
WHERE idempotency_key = ? AND answered_at IS NULL
`.trim();

// ----- Row shape ------------------------------------------------------------

type QuestionRow = {
  readonly question: string;
  readonly options_json: string | null;
  readonly source_refs: string;
  readonly idempotency_key: string;
};

// ----- Public functions -----------------------------------------------------

/**
 * Insert a QuestionEffect row. The table's `idempotency_key UNIQUE`
 * constraint means a re-emission with the same key is silently deduped via
 * `INSERT OR IGNORE` (per spec semantics for QuestionEffect.idempotencyKey).
 *
 * Throws on SQLite-level failure (disk full).
 */
export function insertQuestion(
  db: ProjectionDb,
  opts: QuestionInsertOpts,
): void {
  const { effect, processorId, adoptedCommit } = opts;
  const optionsJson =
    effect.options === undefined ? null : JSON.stringify(effect.options);
  db.raw.query(INSERT_QUESTION_SQL).run(
    effect.question,
    optionsJson,
    JSON.stringify(effect.sourceRefs),
    effect.idempotencyKey,
    processorId,
    adoptedCommit,
    new Date().toISOString(),
  );
}

/**
 * Read questions, optionally filtered by resolution status. `resolved:
 * true` returns questions the user has answered; `resolved: false` returns
 * pending questions; omitted returns everything. Returns a frozen array;
 * ordering is insertion order.
 */
export function queryQuestions(
  db: ProjectionDb,
  filter?: QuestionsFilter,
): ReadonlyArray<QuestionEffect> {
  let rows: ReadonlyArray<QuestionRow>;
  if (filter?.resolved === true) {
    rows = db.raw.query<QuestionRow, []>(QUERY_RESOLVED_SQL).all();
  } else if (filter?.resolved === false) {
    rows = db.raw.query<QuestionRow, []>(QUERY_UNRESOLVED_SQL).all();
  } else {
    rows = db.raw.query<QuestionRow, []>(QUERY_ALL_SQL).all();
  }
  return Object.freeze(rows.map(rowToQuestion));
}

/**
 * Mark a question as answered. No-op if no matching pending question
 * exists (already answered or no such idempotency key).
 */
export function answerQuestion(
  db: ProjectionDb,
  opts: AnswerQuestionOpts,
): void {
  db.raw.query(ANSWER_SQL).run(
    opts.answer,
    new Date().toISOString(),
    opts.idempotencyKey,
  );
}

// ----- internals ------------------------------------------------------------

function rowToQuestion(row: QuestionRow): QuestionEffect {
  const sourceRefs = JSON.parse(row.source_refs) as ReadonlyArray<SourceRef>;
  const options =
    row.options_json === null
      ? undefined
      : (JSON.parse(row.options_json) as ReadonlyArray<string>);
  const input: Omit<QuestionEffect, "kind"> =
    options === undefined
      ? {
          question: row.question,
          sourceRefs,
          idempotencyKey: row.idempotency_key,
        }
      : {
          question: row.question,
          sourceRefs,
          idempotencyKey: row.idempotency_key,
          options,
        };
  return questionEffect(input);
}
