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
//   - JSON columns (`options_json`, `metadata_json`, `source_refs`) serialized via
//     `JSON.stringify`; symmetric `JSON.parse` on read.
//   - Row → QuestionEffect deserialization goes through `questionEffect`.
//   - Returned arrays are `Object.freeze`'d.
//   - INSERT honors the `idempotency_key UNIQUE` constraint by refreshing
//     unanswered rows on re-emission while preserving answered rows.

import { z } from "zod";

import type { QuestionEffect, QuestionMetadata } from "../core/effect";
import { questionEffect, QuestionEffectSchema } from "../core/effect";
import { commitOid, type CommitOid, type SourceRef } from "../core/source-ref";
import {
  parseOptionalJsonColumn,
  parseSourceRefsColumn,
} from "../sqlite/row-json";
import type { ProjectionDb } from "./db";

// ----- Public types ---------------------------------------------------------

export type QuestionInsertOpts = {
  readonly effect: QuestionEffect;
  readonly processorId: string;
  readonly runId: string;
  readonly adoptedCommit: CommitOid;
};

export type QuestionsFilter = {
  readonly resolved?: boolean;
};

export type QuestionRecord = {
  readonly id: number;
  readonly effect: QuestionEffect;
  readonly processorId: string;
  readonly runId: string;
  readonly adoptedCommit: CommitOid;
  readonly askedAt: string;
  readonly answeredAt: string | null;
  readonly answer: string | null;
};

export type AnswerQuestionOpts = {
  readonly idempotencyKey: string;
  readonly answer: string;
  readonly answeredAt?: string;
};

export type AnswerQuestionByIdOpts = {
  readonly id: number;
  readonly answer: string;
  readonly answeredAt?: string;
};

export type ApplyQuestionAnswerOpts = {
  readonly idempotencyKey: string;
  readonly answer: string;
  readonly answeredAt: string;
};

export type ResolveStaleQuestionsOpts = {
  readonly processorId: string;
  readonly inspectedPaths: ReadonlyArray<string>;
  readonly emittedQuestions: ReadonlyArray<QuestionEffect>;
};

export type AnswerQuestionResult =
  | { readonly kind: "answered"; readonly record: QuestionRecord }
  | { readonly kind: "already-answered"; readonly record: QuestionRecord }
  | {
      readonly kind: "invalid-option";
      readonly record: QuestionRecord;
      readonly options: ReadonlyArray<string>;
    }
  | { readonly kind: "not-found" };

// ----- SQL ------------------------------------------------------------------

const INSERT_QUESTION_SQL = `
INSERT INTO questions (
  question, options_json, metadata_json, source_refs, idempotency_key,
  processor_id, run_id, adopted_commit, asked_at, answered_at, answer
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
ON CONFLICT(idempotency_key) DO UPDATE SET
  question = excluded.question,
  options_json = excluded.options_json,
  metadata_json = excluded.metadata_json,
  source_refs = excluded.source_refs,
  processor_id = excluded.processor_id,
  run_id = excluded.run_id,
  adopted_commit = excluded.adopted_commit
WHERE questions.answered_at IS NULL
`.trim();

const QUERY_ALL_SQL = `
SELECT id, question, options_json, metadata_json, source_refs, idempotency_key,
       processor_id, run_id, adopted_commit, asked_at, answered_at, answer
FROM questions
ORDER BY id
`.trim();

const QUERY_RESOLVED_SQL = `
SELECT id, question, options_json, metadata_json, source_refs, idempotency_key,
       processor_id, run_id, adopted_commit, asked_at, answered_at, answer
FROM questions
WHERE answered_at IS NOT NULL
ORDER BY id
`.trim();

const QUERY_UNRESOLVED_SQL = `
SELECT id, question, options_json, metadata_json, source_refs, idempotency_key,
       processor_id, run_id, adopted_commit, asked_at, answered_at, answer
FROM questions
WHERE answered_at IS NULL
ORDER BY id
`.trim();

const QUERY_BY_ID_SQL = `
SELECT id, question, options_json, metadata_json, source_refs, idempotency_key,
       processor_id, run_id, adopted_commit, asked_at, answered_at, answer
FROM questions
WHERE id = ?
`.trim();

const ANSWER_SQL = `
UPDATE questions
SET answer = ?, answered_at = ?
WHERE idempotency_key = ? AND answered_at IS NULL
`.trim();

const ANSWER_BY_ID_SQL = `
UPDATE questions
SET answer = ?, answered_at = ?
WHERE id = ? AND answered_at IS NULL
`.trim();

const APPLY_ANSWER_SQL = `
UPDATE questions
SET answer = ?, answered_at = ?
WHERE idempotency_key = ?
`.trim();

const QUERY_BY_PROCESSOR_SQL = `
SELECT id, idempotency_key, source_refs
FROM questions
WHERE processor_id = ? AND answered_at IS NULL
`.trim();

const DELETE_BY_ID_SQL = `
DELETE FROM questions
WHERE id = ?
`.trim();

// ----- Row shape ------------------------------------------------------------

type QuestionRow = {
  readonly id: number;
  readonly question: string;
  readonly options_json: string | null;
  readonly metadata_json: string | null;
  readonly source_refs: string;
  readonly idempotency_key: string;
  readonly processor_id: string;
  readonly run_id: string;
  readonly adopted_commit: string;
  readonly asked_at: string;
  readonly answered_at: string | null;
  readonly answer: string | null;
};

type QuestionStaleRow = {
  readonly id: number;
  readonly idempotency_key: string;
  readonly source_refs: string;
};

const QuestionOptionsSchema = z.array(z.string().min(1));
const QuestionMetadataSchema = z
  .object({
    risk: z.enum(["low", "medium", "high"]).optional(),
    confidence: z.number().min(0).max(1).optional(),
    recommendedAnswer: z.string().min(1).optional(),
    automationPolicy: z
      .enum(["agent-safe", "model-safe", "owner-needed"])
      .optional(),
    ownerNeededReason: z.string().min(1).optional(),
  })
  .strict();

// ----- Public functions -----------------------------------------------------

/**
 * Insert a QuestionEffect row. The table's `idempotency_key UNIQUE`
 * constraint means a re-emission with the same key keeps one durable row.
 * Unanswered rows refresh their wording/source refs so semantic questions keep
 * current provenance when source lines move; answered rows stay untouched so
 * durable answers remain auditable.
 *
 * Throws on SQLite-level failure (disk full).
 */
export function insertQuestion(
  db: ProjectionDb,
  opts: QuestionInsertOpts,
): void {
  const { effect, processorId, runId, adoptedCommit } = opts;
  const optionsJson =
    effect.options === undefined ? null : JSON.stringify(effect.options);
  const metadataJson =
    effect.metadata === undefined ? null : JSON.stringify(effect.metadata);
  db.raw.query(INSERT_QUESTION_SQL).run(
    effect.question,
    optionsJson,
    metadataJson,
    JSON.stringify(effect.sourceRefs),
    effect.idempotencyKey,
    processorId,
    runId,
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
  return Object.freeze(
    queryQuestionRecords(db, filter).map((record) => record.effect),
  );
}

/**
 * Read durable question rows, optionally filtered by resolution status.
 * This is the operational surface used by CLI/recovery flows that need
 * stable row ids and answer metadata; processor QueryViews should normally
 * keep using `queryQuestions`, which exposes only the Effect-level contract.
 */
export function queryQuestionRecords(
  db: ProjectionDb,
  filter?: QuestionsFilter,
): ReadonlyArray<QuestionRecord> {
  let rows: ReadonlyArray<QuestionRow>;
  if (filter?.resolved === true) {
    rows = db.raw.query<QuestionRow, []>(QUERY_RESOLVED_SQL).all();
  } else if (filter?.resolved === false) {
    rows = db.raw.query<QuestionRow, []>(QUERY_UNRESOLVED_SQL).all();
  } else {
    rows = db.raw.query<QuestionRow, []>(QUERY_ALL_SQL).all();
  }
  return Object.freeze(rows.map(rowToQuestionRecord));
}

/**
 * Read one durable question row by its public CLI id.
 */
export function getQuestionRecord(
  db: ProjectionDb,
  id: number,
): QuestionRecord | null {
  const row = db.raw.query<QuestionRow, [number]>(QUERY_BY_ID_SQL).get(id);
  return row === null ? null : rowToQuestionRecord(row);
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
    opts.answeredAt ?? new Date().toISOString(),
    opts.idempotencyKey,
  );
}

/**
 * Apply a previously durable answer to the rebuildable projection row.
 * Unlike `answerQuestion`, this overwrites the row because the durable
 * answers store is the source of truth during projection rebuild.
 */
export function applyQuestionAnswer(
  db: ProjectionDb,
  opts: ApplyQuestionAnswerOpts,
): void {
  db.raw.query(APPLY_ANSWER_SQL).run(
    opts.answer,
    opts.answeredAt,
    opts.idempotencyKey,
  );
}

/**
 * Mark a question row as answered by public row id. This is intentionally
 * stricter than the legacy idempotency-key helper: it validates choices for
 * multiple-choice questions and reports the reason when no mutation happens.
 */
export function answerQuestionById(
  db: ProjectionDb,
  opts: AnswerQuestionByIdOpts,
): AnswerQuestionResult {
  const record = getQuestionRecord(db, opts.id);
  if (record === null) return { kind: "not-found" };
  if (record.answeredAt !== null) {
    return Object.freeze({ kind: "already-answered", record });
  }

  const choices = record.effect.options;
  if (choices !== undefined && !choices.includes(opts.answer)) {
    return Object.freeze({
      kind: "invalid-option",
      record,
      options: choices,
    });
  }

  db.raw.query(ANSWER_BY_ID_SQL).run(
    opts.answer,
    opts.answeredAt ?? new Date().toISOString(),
    opts.id,
  );
  const answered = getQuestionRecord(db, opts.id);
  if (answered === null) return { kind: "not-found" };
  return Object.freeze({ kind: "answered", record: answered });
}

/**
 * Delete stale derived questions for a processor after it re-checks a bounded
 * set of paths. A prior question from the same processor whose source refs
 * touch an inspected path is kept only when this run re-emitted the same
 * idempotency key.
 *
 * This is intentionally projection-owned. Processors remain pure effect
 * producers; they don't need to remember or mutate their prior rows.
 */
export function resolveStaleQuestions(
  db: ProjectionDb,
  opts: ResolveStaleQuestionsOpts,
): number {
  if (opts.inspectedPaths.length === 0) return 0;
  const inspected = new Set(opts.inspectedPaths);
  const keep = new Set(
    opts.emittedQuestions.map((effect) => effect.idempotencyKey),
  );
  const rows = db.raw
    .query<QuestionStaleRow, [string]>(QUERY_BY_PROCESSOR_SQL)
    .all(opts.processorId);

  let deleted = 0;
  const stmt = db.raw.query(DELETE_BY_ID_SQL);
  for (const row of rows) {
    if (!questionTouchesAnyPath(row.source_refs, inspected)) continue;
    if (keep.has(row.idempotency_key)) continue;
    stmt.run(row.id);
    deleted += 1;
  }
  return deleted;
}

// ----- internals ------------------------------------------------------------

function rowToQuestionRecord(row: QuestionRow): QuestionRecord {
  return Object.freeze({
    id: row.id,
    effect: rowToQuestion(row),
    processorId: row.processor_id,
    runId: row.run_id,
    adoptedCommit: commitOid(row.adopted_commit),
    askedAt: row.asked_at,
    answeredAt: row.answered_at,
    answer: row.answer,
  });
}

function rowToQuestion(row: QuestionRow): QuestionEffect {
  const sourceRefs = parseSourceRefsColumn(
    row.source_refs,
    "questions.source_refs",
  );
  const options = parseOptionalJsonColumn(
    row.options_json,
    "questions.options_json",
    QuestionOptionsSchema,
  );
  const metadata = parseOptionalJsonColumn(
    row.metadata_json,
    "questions.metadata_json",
    QuestionMetadataSchema,
  );
  const input: {
    -readonly [K in keyof Omit<QuestionEffect, "kind">]: Omit<
      QuestionEffect,
      "kind"
    >[K];
  } = {
    question: row.question,
    sourceRefs,
    idempotencyKey: row.idempotency_key,
  };
  if (options !== undefined) input.options = options;
  if (metadata !== undefined) input.metadata = questionMetadata(metadata);
  const effect = questionEffect(input);
  QuestionEffectSchema.parse(effect);
  return effect;
}

function questionMetadata(raw: {
  readonly risk?: "low" | "medium" | "high" | undefined;
  readonly confidence?: number | undefined;
  readonly recommendedAnswer?: string | undefined;
  readonly automationPolicy?: "agent-safe" | "model-safe" | "owner-needed" | undefined;
  readonly ownerNeededReason?: string | undefined;
}): QuestionMetadata {
  const metadata: {
    -readonly [K in keyof QuestionMetadata]: QuestionMetadata[K];
  } = {};
  if (raw.risk !== undefined) metadata.risk = raw.risk;
  if (raw.confidence !== undefined) metadata.confidence = raw.confidence;
  if (raw.recommendedAnswer !== undefined) {
    metadata.recommendedAnswer = raw.recommendedAnswer;
  }
  if (raw.automationPolicy !== undefined) {
    metadata.automationPolicy = raw.automationPolicy;
  }
  if (raw.ownerNeededReason !== undefined) {
    metadata.ownerNeededReason = raw.ownerNeededReason;
  }
  return Object.freeze(metadata);
}

function questionTouchesAnyPath(
  sourceRefsJson: string,
  paths: ReadonlySet<string>,
): boolean {
  let refs: ReadonlyArray<SourceRef>;
  try {
    refs = parseSourceRefsColumn(
      sourceRefsJson,
      "questions.source_refs",
    );
  } catch {
    return false;
  }
  return refs.some((ref) => paths.has(ref.path as string));
}
