// Shared thin input-parsing helpers for dome.search view processors.
//
// `dome query` and `dome export-context` receive the same command-input
// envelope (a positional `commandArgs` record with a nested `flags` record,
// or the bare record when the CLI passes args flat). These helpers narrow the
// untyped envelope identically for both surfaces; the per-processor parse
// functions stay local because their *output* shapes (QueryInput vs
// ExportInput) and limit bounds differ. `questionSearchText` is the shared
// topic-match text projection over a question row — both processors carry the
// same `question`/`options`/`metadata` fields, so the body is structural.

import type { QuestionMetadata } from "../../../../src/core/effect";
export { normalizedTokens } from "../../../../src/recall/query-analysis";

/**
 * Unwrap the command-input envelope to the args record. The CLI passes either
 * `{ commandArgs: {...} }` (positional invocation) or the bare args record
 * (flat invocation); a non-object input degrades to an empty record.
 */
export function commandArgsRecord(input: unknown): Record<string, unknown> {
  const envelope = input !== null && typeof input === "object"
    ? input as Record<string, unknown>
    : {};
  return envelope.commandArgs !== null &&
      typeof envelope.commandArgs === "object"
    ? envelope.commandArgs as Record<string, unknown>
    : envelope;
}

/** The nested `flags` record on an args record, or an empty record. */
export function flagsRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return record.flags !== null && typeof record.flags === "object"
    ? record.flags as Record<string, unknown>
    : {};
}

/** A trimmed non-empty string value, or null. */
export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/** A finite number value (parsing numeric strings), or null. */
export function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Clamp a raw limit into [1, max], defaulting when absent/non-finite. The
 * bounds differ per surface (query: default 10 / max 50; export-context:
 * default 8 / max 25), so they are caller-supplied.
 */
export function clampLimit(
  raw: number | null,
  bounds: { readonly defaultLimit: number; readonly maxLimit: number },
): number {
  if (raw === null || !Number.isFinite(raw)) return bounds.defaultLimit;
  return Math.max(1, Math.min(bounds.maxLimit, Math.trunc(raw)));
}

/** A question row carrying the fields the topic-match text projection reads. */
type QuestionSearchRow = {
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly metadata?: QuestionMetadata | null;
};

/** The whitespace-joined text a question contributes to topic matching. */
export function questionSearchText(question: QuestionSearchRow): string {
  return [
    question.question,
    ...question.options,
    question.metadata?.recommendedAnswer ?? "",
    question.metadata?.ownerNeededReason ?? "",
  ].join(" ");
}
