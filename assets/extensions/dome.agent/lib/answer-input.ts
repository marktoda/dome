// dome.agent shared answer-envelope parsing.
//
// Answer-handler processors (sweep-answer, preference-promotion-answer) receive
// `ctx.input` as the engine's answer envelope: the original question's
// idempotency key + sourceRefs (+ optional metadata), the owner's answer text,
// and the answeredAt timestamp. Each handler validated this shape with a
// near-identical hand-written guard; this is the one source of truth so the
// accepted envelope shape cannot drift between handlers.
//
// Scope note: this is the dome.agent envelope (answeredAt required). The
// dome.health bundle parses its own (simpler) envelope — bundles stay
// independently shippable, so they are intentionally not coupled to this
// helper.
//
// This file lives under `assets/` (excluded from the root tsconfig). Imports
// use relative paths into `src/`, resolved at runtime by Bun's loader.

import type { QuestionEffect } from "../../../../src/core/effect";

export type AnswerInput = {
  readonly question: {
    readonly idempotencyKey: string;
    readonly sourceRefs: QuestionEffect["sourceRefs"];
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
  readonly answer: string;
  readonly answeredAt: string;
};

/**
 * Validate and freeze the engine answer envelope. Returns null (no throw) when
 * any required field is missing or wrong-typed, or when `answeredAt` is not a
 * parseable date — callers emit a warning diagnostic and return no effects.
 * The question's `metadata` is carried through when present (handlers that
 * don't need it simply ignore it).
 */
export function parseAnswerInput(input: unknown): AnswerInput | null {
  if (input === null || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const question = record.question;
  if (question === null || typeof question !== "object") return null;
  const questionRecord = question as Record<string, unknown>;
  if (typeof questionRecord.idempotencyKey !== "string") return null;
  if (!Array.isArray(questionRecord.sourceRefs)) return null;
  if (typeof record.answer !== "string") return null;
  if (typeof record.answeredAt !== "string") return null;
  if (Number.isNaN(Date.parse(record.answeredAt))) return null;
  const metadata =
    questionRecord.metadata !== null && typeof questionRecord.metadata === "object"
      ? (questionRecord.metadata as Readonly<Record<string, unknown>>)
      : undefined;
  return Object.freeze({
    question: Object.freeze({
      idempotencyKey: questionRecord.idempotencyKey,
      sourceRefs: questionRecord.sourceRefs as AnswerInput["question"]["sourceRefs"],
      ...(metadata !== undefined ? { metadata } : {}),
    }),
    answer: record.answer,
    answeredAt: record.answeredAt,
  });
}
