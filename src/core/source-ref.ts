// SourceRef + TextRange: the provenance pointer carried by FactEffect,
// QuestionEffect, ExternalActionEffect, DiagnosticEffect, PatchEffect, and
// ViewEffect.scope. A SourceRef names evidence inside an *adopted* commit, so
// that `dome query` snippets remain durably resolvable (the commit OID is
// stable, the blob is reachable, the range is valid).
//
// See docs/wiki/specs/effects.md §"The SourceRef type" for the normative
// contract. Pure type definitions + Zod boundary schemas + a small
// constructor helper; no filesystem, git, or sqlite dependencies.

import { z } from "zod";

// ----- Branded OID aliases --------------------------------------------------

/** A 40-char hex SHA-1 identifying a git commit object. */
export type CommitOid = string;

/** A 40-char hex SHA-1 identifying a git blob object. */
export type BlobOid = string;

// ----- TextRange ------------------------------------------------------------

/**
 * A line/character range inside a blob. Lines are 1-indexed; character
 * offsets, when present, are 0-indexed into the line. `startChar`/`endChar`
 * are optional — most call sites identify regions by whole lines.
 */
export type TextRange = {
  readonly startLine: number;
  readonly endLine: number;
  readonly startChar?: number;
  readonly endChar?: number;
};

// ----- SourceRef ------------------------------------------------------------

/**
 * A pointer to evidence inside an adopted commit. `commit` + `path` is the
 * minimum identification; `blob` and `range` narrow within the file; and
 * `stableId` names a marker-delimited region or stable-id'd task when
 * path/range identity is insufficient (see effects.md §"The SourceRef type").
 */
export type SourceRef = {
  readonly commit: CommitOid;
  readonly path: string;
  readonly blob?: BlobOid;
  readonly range?: TextRange;
  readonly stableId?: string;
};

// ----- Zod schemas ----------------------------------------------------------
// Boundary validation only. `.strict()` makes unknown keys a validation
// error — SourceRef is a closed shape.
//
// Not annotated as `z.ZodType<SourceRef>` because zod's `.optional()` emits
// `key?: T | undefined`, which collides with exactOptionalPropertyTypes.
// Consumers should rely on the SourceRef type for downstream typing rather
// than `z.infer<typeof SourceRefSchema>`.

export const TextRangeSchema = z
  .object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    startChar: z.number().int().nonnegative().optional(),
    endChar: z.number().int().nonnegative().optional(),
  })
  .strict();

export const SourceRefSchema = z
  .object({
    commit: z.string().min(1), // commit OIDs are non-empty 40-char hex; loose v1 check
    path: z.string().min(1),   // vault-relative paths are non-empty
    blob: z.string().min(1).optional(),
    range: TextRangeSchema.optional(),
    stableId: z.string().min(1).optional(),
  })
  .strict();

// ----- Constructor helper ---------------------------------------------------

/**
 * Build a frozen SourceRef from a typed input. No validation — the type
 * system already enforces the shape at the call site; Zod schemas are for
 * untrusted boundaries (config files, protocol payloads, sqlite reads).
 *
 * Optional fields are only set on the returned object when defined, so the
 * result is `exactOptionalPropertyTypes`-clean (no `field: undefined` keys).
 *
 * Object.freeze chosen over `as const` so misbehaving processors fail loudly
 * at runtime rather than silently corrupting facts.
 */
export function sourceRef(input: SourceRef): SourceRef {
  const ref: { -readonly [K in keyof SourceRef]: SourceRef[K] } = {
    commit: input.commit,
    path: input.path,
  };
  if (input.blob !== undefined) ref.blob = input.blob;
  if (input.range !== undefined) ref.range = input.range;
  if (input.stableId !== undefined) ref.stableId = input.stableId;
  return Object.freeze(ref);
}
