// schema-type-lockstep: compile-time drift fences between hand-written
// canonical types and their Zod boundary schemas
// (docs/wiki/gotchas/boundary-validation-via-zod.md §"Type/schema lockstep").
//
// Hand-written types are canonical; schemas validate. zod (v4 included)
// infers `.optional()` as `field?: T | undefined`, which
// `exactOptionalPropertyTypes` rejects against the house `field?: T` style —
// so the types cannot be `z.infer` aliases. This file pins the two instead:
//
//   1. Hand extends Inferred  — the schema is not stricter than the type
//      (every value the type permits, the schema's shape accepts).
//   2. Inferred extends DeepLoose<Hand> — the type is not stricter than the
//      schema, modulo the exact-optional gap (`| undefined` is forgiven on
//      every field, which is precisely the gap zod cannot express).
//
// A schema field added without the hand type — or a hand-type field the
// schema doesn't carry — fails `bun run typecheck` (and `v1:check`).
// This file is type-only: bun test never executes it (no .test.ts suffix);
// tsc covers it via the main project include.

import type { z } from "zod";

import type {
  DiagnosticEffect,
  Effect,
  ExternalActionEffect,
  FactEffect,
  FileChange,
  OutboxRecoveryEffect,
  PatchEffect,
  QuarantineRecoveryEffect,
  QuestionEffect,
  RunRecoveryEffect,
  SearchDocumentEffect,
  ViewEffect,
} from "../../src/core/effect";
import type {
  DiagnosticEffectSchema,
  EffectSchema,
  ExternalActionEffectSchema,
  FactEffectSchema,
  FileChangeSchema,
  OutboxRecoveryEffectSchema,
  PatchEffectSchema,
  QuarantineRecoveryEffectSchema,
  QuestionEffectSchema,
  RunRecoveryEffectSchema,
  SearchDocumentEffectSchema,
  ViewEffectSchema,
} from "../../src/core/effect";
import type { SourceRef, SourceRefSchema } from "../../src/core/source-ref";
import type { Manifest } from "../../src/extensions/manifest-schema";
import { type ManifestSchema } from "../../src/extensions/manifest-schema";

// ----- fence machinery -------------------------------------------------------

/** Compile-time-only assertion that `A` is assignable to `B` (non-distributive). */
type Extends<A, B> = [A] extends [B] ? true : false;

/**
 * Erase `__brand` intersections on primitives. Some schemas brand on parse
 * (VaultPath pipes through `requireVaultPath`); others validate the base
 * shape and leave branding to the constructors (`commitOid`, `blobOid` are
 * applied by readers like `parseSourceRefsColumn`). Branding is
 * constructor-domain, not schema-domain, so the fence compares brand-erased.
 */
type DeBrand<T> = T extends { readonly __brand: unknown }
  ? T extends string
    ? string
    : T extends number
      ? number
      : T
  : T;

/**
 * Loosen a hand-written type by forgiving `| undefined` on every property
 * and erasing primitive brands, recursively — the exact shape zod's
 * `.optional()` inference produces. Optionality modifiers, literal types,
 * and union structure are preserved.
 */
type DeepLoose<T> = T extends string | number | boolean | bigint | null | undefined
  ? DeBrand<T>
  : T extends ReadonlyArray<infer E>
    ? ReadonlyArray<DeepLoose<E>>
    : T extends object
      ? { [K in keyof T]: DeepLoose<T[K]> | undefined }
      : T;

/**
 * View a type with every array readonly, recursively. The hand types use
 * `ReadonlyArray`; zod infers mutable arrays. Mutability is not drift, so
 * direction 1 compares against this view.
 */
type DeepRO<T> = T extends string | number | boolean | bigint | null | undefined
  ? T
  : T extends ReadonlyArray<infer E>
    ? ReadonlyArray<DeepRO<E>>
    : T extends object
      ? { [K in keyof T]: DeepRO<T[K]> }
      : T;

/** One fence per schema/type pair; both directions must be `true`. */
type Lockstep<Schema extends z.ZodType, Hand> = [
  Extends<Hand, DeepRO<z.output<Schema>>>,
  Extends<z.output<Schema>, DeepLoose<Hand>>,
];

/**
 * Direction-0-only fence for pairs where the hand type is a discriminated
 * union but the schema is a flat object whose runtime refinements encode
 * the union (SearchDocumentEffect: `category`/`title`/`body` required for
 * upsert, forbidden-for-delete fields). The flat inferred type cannot
 * structurally extend the union; the refinements are the schema-side
 * encoding, exercised by tests/core/effect.test.ts.
 */
type LockstepFlatRefined<Schema extends z.ZodType, Hand> = [
  Extends<Hand, DeepRO<z.output<Schema>>>,
  true,
];

/**
 * The Effect-union fence. Direction 1 excludes the `search-document` kind,
 * which carries the flat-refined exception above; the other nine kinds are
 * held to the full bidirectional contract at the union level too.
 */
type LockstepEffectUnion<Schema extends z.ZodType, Hand> = [
  Extends<Hand, DeepRO<z.output<Schema>>>,
  Extends<
    Exclude<z.output<Schema>, { kind: "search-document" }>,
    DeepLoose<Exclude<Hand, { kind: "search-document" }>>
  >,
];

type AssertAll<T extends ReadonlyArray<[true, true]>> = T;

// ----- the fences ------------------------------------------------------------

export type SchemaTypeLockstep = AssertAll<
  [
    Lockstep<typeof FileChangeSchema, FileChange>,
    Lockstep<typeof PatchEffectSchema, PatchEffect>,
    Lockstep<typeof DiagnosticEffectSchema, DiagnosticEffect>,
    Lockstep<typeof FactEffectSchema, FactEffect>,
    LockstepFlatRefined<typeof SearchDocumentEffectSchema, SearchDocumentEffect>,
    Lockstep<typeof QuestionEffectSchema, QuestionEffect>,
    Lockstep<typeof ExternalActionEffectSchema, ExternalActionEffect>,
    Lockstep<typeof OutboxRecoveryEffectSchema, OutboxRecoveryEffect>,
    Lockstep<typeof QuarantineRecoveryEffectSchema, QuarantineRecoveryEffect>,
    Lockstep<typeof RunRecoveryEffectSchema, RunRecoveryEffect>,
    Lockstep<typeof ViewEffectSchema, ViewEffect>,
    LockstepEffectUnion<typeof EffectSchema, Effect>,
    Lockstep<typeof SourceRefSchema, SourceRef>,
    Lockstep<typeof ManifestSchema, Manifest>,
  ]
>;
