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
import {
  requireVaultPath,
  VaultPathSchema,
  type VaultPath,
} from "./vault-path";

// ----- Branded OID aliases --------------------------------------------------
//
// Structurally branded so a raw `string` cannot accidentally flow into a slot
// expecting a CommitOid/BlobOid. Use the `commitOid()` / `blobOid()` value
// helpers below to brand an arbitrary string (e.g., a `currentSha()` return).
// v1 enforces only non-empty; future tightening can validate 40-char hex
// inside the helpers without touching the call sites.

/** A 40-char hex SHA-1 identifying a git commit object. */
export type CommitOid = string & { readonly __brand: "CommitOid" };

/** A 40-char hex SHA-1 identifying a git blob object. */
export type BlobOid = string & { readonly __brand: "BlobOid" };

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
  readonly path: VaultPath;
  readonly blob?: BlobOid;
  readonly range?: TextRange;
  readonly stableId?: string;
};

export type SourceRefInput = Omit<SourceRef, "path"> & {
  readonly path: string | VaultPath;
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
  .strict()
  .superRefine((value, ctx) => {
    if (value.endLine < value.startLine) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "TextRange.endLine must be greater than or equal to startLine",
        path: ["endLine"],
      });
    }
    if (
      value.endLine === value.startLine &&
      value.startChar !== undefined &&
      value.endChar !== undefined &&
      value.endChar < value.startChar
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "TextRange.endChar must be greater than or equal to startChar on one-line ranges",
        path: ["endChar"],
      });
    }
  });

export const SourceRefSchema = z
  .object({
    commit: z.string().min(1), // commit OIDs are non-empty 40-char hex; loose v1 check
    path: VaultPathSchema,
    blob: z.string().min(1).optional(),
    range: TextRangeSchema.optional(),
    stableId: z.string().min(1).optional(),
  })
  .strict();

// ----- Constructor helper ---------------------------------------------------

/**
 * Build a frozen SourceRef from a typed input. The path is canonicalized here
 * so provenance emitted by processors uses the same VaultPath representation
 * as schema-validated protocol payloads and sqlite reads.
 *
 * Optional fields are only set on the returned object when defined, so the
 * result is `exactOptionalPropertyTypes`-clean (no `field: undefined` keys).
 *
 * Object.freeze chosen over `as const` so misbehaving processors fail loudly
 * at runtime rather than silently corrupting facts.
 */
export function sourceRef(input: SourceRefInput): SourceRef {
  const ref: { -readonly [K in keyof SourceRef]: SourceRef[K] } = {
    commit: input.commit,
    path: requireVaultPath(input.path, "SourceRef.path"),
  };
  if (input.blob !== undefined) ref.blob = input.blob;
  if (input.range !== undefined) ref.range = input.range;
  if (input.stableId !== undefined) ref.stableId = input.stableId;
  return Object.freeze(ref);
}

// ----- OID brand helpers ----------------------------------------------------
//
// The branded OID types above are pure type-level brands; these value helpers
// are the single-call-site way to inject a raw `string` (e.g., a `currentSha()`
// return, a git-boundary path string) into a CommitOid / BlobOid slot. v1
// performs no validation beyond the type system; a future tightening can
// validate 40-char hex inside these helpers without touching call sites.

/** Brand a raw string as a CommitOid. v1 enforces only non-empty via the type system. */
export function commitOid(s: string): CommitOid {
  return s as CommitOid;
}

/** Brand a raw string as a BlobOid. */
export function blobOid(s: string): BlobOid {
  return s as BlobOid;
}
