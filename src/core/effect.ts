// The seven-kind Effect union: the only value a Processor returns.
//
// The engine routes effects through capability enforcement, then applies
// them — patching markdown, writing to the projection store, queueing
// external actions, rendering views. The taxonomy is *closed*: plugins
// emit existing kinds, not new ones. See docs/wiki/specs/effects.md for
// the normative contract (kind-by-kind shape, routing, capability matrix,
// and the rationale for closedness).
//
// Pure type definitions + Zod boundary schemas + per-kind constructor
// helpers. No filesystem, git, or sqlite dependencies.
//
// House-style notes (matches src/core/source-ref.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Optional fields use `field?: T` (not `T | undefined`) for
//     `exactOptionalPropertyTypes` cleanliness.
//   - Zod object schemas use `.strict()` (unknown keys are validation
//     errors — effect shapes are closed).
//   - Schemas are not annotated as `z.ZodType<T>`: zod's `.optional()`
//     emits `T | undefined`, which collides with
//     `exactOptionalPropertyTypes`. Downstream code should type from
//     the `Effect` union, not `z.infer<typeof EffectSchema>`.

import { z } from "zod";
import { SourceRefSchema, type SourceRef } from "./source-ref";
import {
  requireVaultPath,
  VaultPathSchema,
  type VaultPath,
} from "./vault-path";

// ----- FileChange (PatchEffect payload) -------------------------------------

/**
 * A single file-level mutation a PatchEffect proposes. Whole-content writes
 * and outright deletes — no in-place diffing at the value layer. The engine's
 * applier (`src/engine/apply-patch.ts`) overlays each change onto the
 * candidate's tree without consulting a diff library.
 *
 * v1 chose whole-content over unified-diff because the engine's apply-side
 * was already plumbing-only (read candidate tree → overlay → write new tree)
 * and the diff-text shape forced an extra parse + hunk-apply step that
 * surfaced an entire class of "drift" failure modes the simpler shape
 * doesn't have. Processors that need to *compute* a diff (e.g., to surface
 * to the user) do so against `change.content` themselves.
 *
 *   - `kind: "write"`  — overwrite (or create) `path` with `content`.
 *   - `kind: "delete"` — remove `path` from the tree.
 */
export type FileChange =
  | {
      readonly kind: "write";
      readonly path: VaultPath;
      readonly content: string;
    }
  | { readonly kind: "delete"; readonly path: VaultPath };

export type FileChangeInput =
  | {
      readonly kind: "write";
      readonly path: string | VaultPath;
      readonly content: string;
    }
  | { readonly kind: "delete"; readonly path: string | VaultPath };

// ----- NodeRef / Literal (FactEffect operands) ------------------------------

/**
 * A reference to a node in the projection graph. `page` names a vault
 * markdown file by path; `task` names a stable-id'd task; `entity` names
 * a wiki/entity by canonical name.
 */
export type NodeRef =
  | { readonly kind: "page"; readonly path: VaultPath }
  | { readonly kind: "task"; readonly stableId: string }
  | { readonly kind: "entity"; readonly name: string };

export type NodeRefInput =
  | { readonly kind: "page"; readonly path: string | VaultPath }
  | { readonly kind: "task"; readonly stableId: string }
  | { readonly kind: "entity"; readonly name: string };

/**
 * A literal value used as the object of a FactEffect when the assertion
 * isn't a relation between nodes (e.g., a due date, a count, a label).
 */
export type Literal =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "date"; readonly value: string }; // ISO-8601

// ----- ViewContent (ViewEffect payload) -------------------------------------

/**
 * The shape of a ViewEffect's payload. `markdown` is the common case;
 * `structured` carries a JSON-ish payload tagged with a schema id the
 * caller can validate against; `stream` carries an async iterable used
 * for streaming LLM responses through the view phase.
 */
export type ViewContent =
  | { readonly kind: "markdown"; readonly body: string }
  | { readonly kind: "structured"; readonly data: unknown; readonly schema: string }
  | { readonly kind: "stream"; readonly chunks: AsyncIterable<string> };

// ----- Effect kinds ---------------------------------------------------------

/**
 * A proposed change to vault markdown. `mode: "auto"` lets the engine
 * apply the changes inline during adoption (subject to `patch.auto`
 * capability); `mode: "propose"` blocks adoption with a diagnostic and
 * surfaces the changes for human review (`dome lint --apply`).
 *
 * `changes` is a non-empty list of whole-content file mutations (writes or
 * deletes). Each entry names a single vault-relative path; the engine's
 * applier overlays them in order onto the candidate tree. See `FileChange`
 * above for the rationale behind whole-content vs unified-diff.
 */
export type PatchEffect = {
  readonly kind: "patch";
  readonly mode: "auto" | "propose";
  readonly changes: ReadonlyArray<FileChange>;
  readonly reason: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

export type PatchEffectInput = Omit<PatchEffect, "kind" | "changes"> & {
  readonly changes: ReadonlyArray<FileChangeInput>;
};

/**
 * A finding the user (or another processor) should see. `severity: "block"`
 * in the adoption phase refuses to advance the adopted ref; `error` and
 * `warning` are surfaced but non-blocking; `info` is silent unless asked.
 */
export type DiagnosticEffect = {
  readonly kind: "diagnostic";
  readonly severity: "info" | "warning" | "error" | "block";
  readonly code: string;
  readonly message: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

/**
 * A structured assertion extracted from the vault. The predicate is
 * namespaced (e.g., `dome.tasks.dueDate`); the engine routes the fact
 * to `projection_store.facts` under the processor's declared
 * `graph.write` namespace. `sourceRefs` is mandatory and non-empty —
 * "no evidence, no durable claim". `confidence` is required for
 * `inferred` and `generated` assertions (enforced in the schema).
 */
export type FactEffect = {
  readonly kind: "fact";
  readonly subject: NodeRef;
  readonly predicate: string;
  readonly object: NodeRef | Literal;
  readonly assertion: "explicit" | "extracted" | "inferred" | "generated";
  readonly sourceRefs: ReadonlyArray<SourceRef>;
  readonly confidence?: number;
};

export type FactEffectInput = Omit<
  FactEffect,
  "kind" | "subject" | "object"
> & {
  readonly subject: NodeRefInput;
  readonly object: NodeRefInput | Literal;
};

/**
 * A question the processor wants to ask the user. `options`, when present,
 * constrains the answer to a multiple-choice pick; absent means free-form.
 * `idempotencyKey` de-dupes the question row on processor retries.
 */
export type QuestionEffect = {
  readonly kind: "question";
  readonly question: string;
  readonly options?: ReadonlyArray<string>;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
  readonly idempotencyKey: string;
};

/**
 * A request to run another processor later. `input` is opaque to the
 * engine — it's the receiving processor's `ProcessorContext.input`.
 * `runAfter`, when present, is an ISO-8601 timestamp; the engine
 * enqueues with a delay. `idempotencyKey` de-dupes the job row.
 */
export type JobEffect = {
  readonly kind: "job";
  readonly processorId: string;
  readonly input: unknown;
  readonly runAfter?: string;
  readonly idempotencyKey: string;
  readonly maxAttempts?: number;
};

/**
 * An effect that touches the outside world (calendar write, email send,
 * webhook POST, notification). The engine inserts an outbox row before
 * attempting the external call; idempotencyKey de-dups retries. Pinned
 * by `EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX`.
 */
export type ExternalActionEffect = {
  readonly kind: "external";
  readonly capability: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

/**
 * A rendered response to a query or command. View effects are *not*
 * persisted by default — they're computed on demand. `scope` lists the
 * pages the view summarizes, for cache invalidation by callers.
 */
export type ViewEffect = {
  readonly kind: "view";
  readonly name: string;
  readonly content: ViewContent;
  readonly scope: ReadonlyArray<SourceRef>;
};

/**
 * The closed Effect union. The engine's `apply-effect.ts` uses an
 * exhaustive `switch` on `kind` (TypeScript `never`-type exhaustiveness)
 * to guarantee every kind has a route. Adding an eighth kind requires a
 * spec change; the codebase fails to compile until every route is added.
 */
export type Effect =
  | PatchEffect
  | DiagnosticEffect
  | FactEffect
  | QuestionEffect
  | JobEffect
  | ExternalActionEffect
  | ViewEffect;

// ----- Zod schemas ----------------------------------------------------------
// Boundary validation only — processors return typed values directly; the
// engine validates at the broker entry point and when reading effect rows
// back from sqlite. `.strict()` rejects unknown keys.

export const NodeRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"), path: VaultPathSchema }).strict(),
  z.object({ kind: z.literal("task"), stableId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("entity"), name: z.string().min(1) }).strict(),
]);

export const LiteralSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("string"), value: z.string() }).strict(),
  z.object({ kind: z.literal("number"), value: z.number() }).strict(),
  z
    .object({ kind: z.literal("date"), value: z.string().datetime({ offset: true }) })
    .strict(),
]);

export const ViewContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("markdown"), body: z.string() }).strict(),
  z
    .object({
      kind: z.literal("structured"),
      data: z.unknown(),
      schema: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("stream"),
      // AsyncIterable has no constructor at validation time; verify the
      // protocol by presence of Symbol.asyncIterator. Sufficient for boundary.
      chunks: z.custom<AsyncIterable<string>>(
        (v) =>
          typeof v === "object" && v !== null && Symbol.asyncIterator in v,
      ),
    })
    .strict(),
]);

export const FileChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("write"),
      path: VaultPathSchema,
      content: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("delete"),
      path: VaultPathSchema,
    })
    .strict(),
]);

export const PatchEffectSchema = z
  .object({
    kind: z.literal("patch"),
    mode: z.enum(["auto", "propose"]),
    // At least one change required — an empty PatchEffect is a programmer
    // error (processors that have nothing to do should return no effect).
    changes: z.array(FileChangeSchema).min(1),
    reason: z.string().min(1),
    sourceRefs: z.array(SourceRefSchema),
  })
  .strict();

export const DiagnosticEffectSchema = z
  .object({
    kind: z.literal("diagnostic"),
    severity: z.enum(["info", "warning", "error", "block"]),
    code: z.string().min(1),
    message: z.string().min(1),
    sourceRefs: z.array(SourceRefSchema),
  })
  .strict();

// Inner object schema for FactEffect. Kept un-refined so it can participate
// in `z.discriminatedUnion` below (which rejects `ZodEffects` produced by
// `.refine()`). The semantic refinements are layered on top in
// `FactEffectSchema` (for direct validation) and re-applied on `EffectSchema`
// via a post-union refinement.
const FactEffectObjectSchema = z
  .object({
    kind: z.literal("fact"),
    subject: NodeRefSchema,
    predicate: z.string().min(1),
    object: z.union([NodeRefSchema, LiteralSchema]),
    assertion: z.enum(["explicit", "extracted", "inferred", "generated"]),
    sourceRefs: z.array(SourceRefSchema),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

/**
 * `sourceRefs` must be non-empty ("no evidence, no durable claim", per
 * effects.md §"FactEffect") and `confidence` is required when `assertion`
 * is `inferred` or `generated`.
 *
 * Parameter widened to `confidence?: number | undefined` so the helper accepts
 * both the inner schema's inference and the union-narrowed `v.kind === 'fact'`
 * branch.
 */
function factEffectRefinements(
  v: {
    readonly sourceRefs: ReadonlyArray<unknown>;
    readonly assertion: "explicit" | "extracted" | "inferred" | "generated";
    readonly confidence?: number | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (v.sourceRefs.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "FactEffect.sourceRefs must be non-empty (no evidence, no durable claim)",
      path: ["sourceRefs"],
    });
  }
  if (
    (v.assertion === "inferred" || v.assertion === "generated") &&
    v.confidence === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "FactEffect.confidence is required when assertion is 'inferred' or 'generated'",
      path: ["confidence"],
    });
  }
}

export const FactEffectSchema = FactEffectObjectSchema.superRefine(
  factEffectRefinements,
);

export const QuestionEffectSchema = z
  .object({
    kind: z.literal("question"),
    question: z.string().min(1),
    options: z.array(z.string().min(1)).optional(),
    sourceRefs: z.array(SourceRefSchema),
    idempotencyKey: z.string().min(1),
  })
  .strict();

export const JobEffectSchema = z
  .object({
    kind: z.literal("job"),
    processorId: z.string().min(1),
    input: z.unknown(),
    runAfter: z.string().datetime({ offset: true }).optional(),
    idempotencyKey: z.string().min(1),
    maxAttempts: z.number().int().positive().optional(),
  })
  .strict();

export const ExternalActionEffectSchema = z
  .object({
    kind: z.literal("external"),
    capability: z.string().min(1),
    idempotencyKey: z.string().min(1),
    payload: z.unknown(),
    sourceRefs: z.array(SourceRefSchema),
  })
  .strict();

export const ViewEffectSchema = z
  .object({
    kind: z.literal("view"),
    name: z.string().min(1),
    content: ViewContentSchema,
    scope: z.array(SourceRefSchema),
  })
  .strict();

/**
 * Discriminated union over the seven effect kinds. Use this at engine
 * entry points (broker validation, sqlite reads). Not exported as the
 * inferred type — consumers should type from the `Effect` union to
 * preserve `exactOptionalPropertyTypes` semantics.
 *
 * `FactEffectObjectSchema` is used here (un-refined) because zod v3's
 * `discriminatedUnion` rejects `ZodEffects` members; the FactEffect
 * semantic refinements are re-applied on the union via `.superRefine`.
 */
export const EffectSchema = z
  .discriminatedUnion("kind", [
    PatchEffectSchema,
    DiagnosticEffectSchema,
    FactEffectObjectSchema,
    QuestionEffectSchema,
    JobEffectSchema,
    ExternalActionEffectSchema,
    ViewEffectSchema,
  ])
  .superRefine((v, ctx) => {
    // Extension point: when adding refinements to other kinds, layer them here. Per-kind helpers stay separate so `<Kind>EffectSchema.parse(...)` validates the same constraints as `EffectSchema.parse(...)`.
    if (v.kind === "fact") factEffectRefinements(v, ctx);
  });

// ----- Constructor helpers --------------------------------------------------
// One per effect kind: takes the kind-less input shape, sets `kind` to the
// literal, canonicalizes path-bearing fields, and freezes the result. Full
// structural validation still lives in the Zod schemas; the constructors only
// enforce the cheap invariants needed to keep engine-internal paths canonical.
//
// Optional fields are only assigned when defined, so the returned object
// is `exactOptionalPropertyTypes`-clean (no `field: undefined` keys).
//
// Object.freeze chosen over `as const` so misbehaving processors fail loudly
// at runtime rather than silently corrupting facts.

export function patchEffect(input: PatchEffectInput): PatchEffect {
  const e: { -readonly [K in keyof PatchEffect]: PatchEffect[K] } = {
    kind: "patch",
    mode: input.mode,
    changes: Object.freeze(input.changes.map(fileChange)),
    reason: input.reason,
    sourceRefs: input.sourceRefs,
  };
  return Object.freeze(e);
}

export function diagnosticEffect(
  input: Omit<DiagnosticEffect, "kind">,
): DiagnosticEffect {
  const e: { -readonly [K in keyof DiagnosticEffect]: DiagnosticEffect[K] } = {
    kind: "diagnostic",
    severity: input.severity,
    code: input.code,
    message: input.message,
    sourceRefs: input.sourceRefs,
  };
  return Object.freeze(e);
}

export function factEffect(input: FactEffectInput): FactEffect {
  const e: { -readonly [K in keyof FactEffect]: FactEffect[K] } = {
    kind: "fact",
    subject: nodeRef(input.subject),
    predicate: input.predicate,
    object: nodeRefOrLiteral(input.object),
    assertion: input.assertion,
    sourceRefs: input.sourceRefs,
  };
  if (input.confidence !== undefined) e.confidence = input.confidence;
  return Object.freeze(e);
}

export function questionEffect(
  input: Omit<QuestionEffect, "kind">,
): QuestionEffect {
  const e: { -readonly [K in keyof QuestionEffect]: QuestionEffect[K] } = {
    kind: "question",
    question: input.question,
    sourceRefs: input.sourceRefs,
    idempotencyKey: input.idempotencyKey,
  };
  if (input.options !== undefined) e.options = input.options;
  return Object.freeze(e);
}

export function jobEffect(input: Omit<JobEffect, "kind">): JobEffect {
  const e: { -readonly [K in keyof JobEffect]: JobEffect[K] } = {
    kind: "job",
    processorId: input.processorId,
    input: input.input,
    idempotencyKey: input.idempotencyKey,
  };
  if (input.runAfter !== undefined) e.runAfter = input.runAfter;
  if (input.maxAttempts !== undefined) e.maxAttempts = input.maxAttempts;
  return Object.freeze(e);
}

export function externalActionEffect(
  input: Omit<ExternalActionEffect, "kind">,
): ExternalActionEffect {
  const e: {
    -readonly [K in keyof ExternalActionEffect]: ExternalActionEffect[K];
  } = {
    kind: "external",
    capability: input.capability,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    sourceRefs: input.sourceRefs,
  };
  return Object.freeze(e);
}

export function viewEffect(input: Omit<ViewEffect, "kind">): ViewEffect {
  const e: { -readonly [K in keyof ViewEffect]: ViewEffect[K] } = {
    kind: "view",
    name: input.name,
    content: input.content,
    scope: input.scope,
  };
  return Object.freeze(e);
}

export function fileChange(input: FileChangeInput): FileChange {
  if (input.kind === "write") {
    return Object.freeze({
      kind: "write",
      path: requireVaultPath(input.path, "FileChange.path"),
      content: input.content,
    });
  }
  return Object.freeze({
    kind: "delete",
    path: requireVaultPath(input.path, "FileChange.path"),
  });
}

export function nodeRef(input: NodeRefInput): NodeRef {
  switch (input.kind) {
    case "page":
      return Object.freeze({
        kind: "page",
        path: requireVaultPath(input.path, "NodeRef.path"),
      });
    case "task":
      return Object.freeze({ kind: "task", stableId: input.stableId });
    case "entity":
      return Object.freeze({ kind: "entity", name: input.name });
  }
}

function nodeRefOrLiteral(input: NodeRefInput | Literal): NodeRef | Literal {
  switch (input.kind) {
    case "page":
    case "task":
    case "entity":
      return nodeRef(input);
    case "string":
    case "number":
    case "date":
      return input;
  }
}
