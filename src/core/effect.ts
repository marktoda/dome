// The ten-kind Effect union: the only value a Processor returns.
//
// The engine routes effects through capability enforcement, then applies
// them — patching markdown, writing to the projection store, queueing
// external actions, recovering operational rows, rendering views.
// The taxonomy is *closed*: plugins
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
//   - Hand-written types are canonical; schemas validate. zod (v4
//     included) infers `.optional()` as `field?: T | undefined`, which
//     `exactOptionalPropertyTypes` rejects against `field?: T` — so
//     downstream code types from the `Effect` union, never
//     `z.infer<typeof EffectSchema>`. Schema/type drift is pinned by the
//     compile-time fences in tests/types/schema-type-lockstep.ts
//     (per docs/wiki/gotchas/boundary-validation-via-zod.md
//     §"Type/schema lockstep").

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
 * applier (`src/engine/core/apply-patch.ts`) overlays each change onto the
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

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

// ----- ViewContent (ViewEffect payload) -------------------------------------

/**
 * The shape of a ViewEffect's payload. `markdown` is the common case;
 * `structured` carries a JSON-ish payload tagged with a schema id the
 * caller can validate against; `stream` carries an async iterable used
 * for streaming LLM responses through the view phase.
 */
export type ViewContent =
  | { readonly kind: "markdown"; readonly body: string }
  | { readonly kind: "structured"; readonly data: JsonValue; readonly schema: string }
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
 * A full-text-search document projection update. Search rows are durable,
 * rebuildable projections over adopted markdown; processors describe the
 * document shape here, and the engine-owned projection sink performs the
 * SQLite FTS write after `search.write` capability enforcement.
 *
 * `operation: "upsert"` replaces any existing row for `path`. `operation:
 * "delete"` removes the row for deleted or unreadable paths. `sourceRefs` is
 * mandatory and non-empty so search results can point back to evidence.
 */
export type SearchDocumentEffect =
  | {
      readonly kind: "search-document";
      readonly operation: "upsert";
      readonly path: VaultPath;
      /**
       * Stable heading-section id (heading slug + ordinal for duplicates,
       * `~N` suffix for sub-split parts; `intro` for pre-first-H2 content).
       * When present, the row identity is the `(path, sectionId)` composite
       * key; absent keeps legacy page-level semantics (replace every row
       * for `path`). See [[wiki/specs/effects]] §SearchDocumentEffect.
       */
      readonly sectionId?: string;
      /** Display breadcrumb: `<page title> › <heading path>`. */
      readonly breadcrumb?: string;
      readonly category: string;
      readonly type?: string;
      readonly title: string;
      readonly body: string;
      readonly sourceRefs: ReadonlyArray<SourceRef>;
    }
  | {
      readonly kind: "search-document";
      readonly operation: "delete";
      readonly path: VaultPath;
      readonly sourceRefs: ReadonlyArray<SourceRef>;
    };

export type SearchDocumentEffectInput =
  | {
      readonly operation: "upsert";
      readonly path: string | VaultPath;
      readonly sectionId?: string;
      readonly breadcrumb?: string;
      readonly category: string;
      readonly type?: string;
      readonly title: string;
      readonly body: string;
      readonly sourceRefs: ReadonlyArray<SourceRef>;
    }
  | {
      readonly operation: "delete";
      readonly path: string | VaultPath;
      readonly sourceRefs: ReadonlyArray<SourceRef>;
    };

export type QuestionRisk = "low" | "medium" | "high";

export type QuestionAutomationPolicy =
  | "agent-safe"
  | "model-safe"
  | "owner-needed";

export type QuestionMetadata = {
  readonly risk?: QuestionRisk;
  readonly confidence?: number;
  readonly recommendedAnswer?: string;
  readonly automationPolicy?: QuestionAutomationPolicy;
  readonly ownerNeededReason?: string;
  /**
   * Round-trip context for answer handlers (question → answer-triggered
   * processor): the destination page the question is about, the material
   * document that prompted it, and the emitting processor's proposed content
   * (caller-capped). Advisory for surfaces; load-bearing only for the
   * emitting bundle's own answer handler (e.g. dome.agent.sweep →
   * dome.agent.sweep-answer reads `proposedSection` to land an owner-approved
   * integration deterministically).
   */
  readonly destination?: string;
  readonly material?: string;
  readonly proposedSection?: string;
  /**
   * The processor this question is actually about, when it differs from the
   * emitting processor (the health-recovery shape: e.g.
   * `dome.health.quarantine-recovery-questions` asks on behalf of the
   * quarantined processor). Subject-liveness expiry
   * (`engine/operational/question-expiry.ts`) treats an OPEN question as
   * expired once either the emitter or this subject is no longer registered.
   * `dome.health.orphan-run-recovery-questions` deliberately never sets this:
   * the stuck run it asks about outlives its processor's retirement, and the
   * question is the run's only disposition path — stamping it would let
   * expiry durably bury an undisposable orphan run.
   */
  readonly subjectProcessorId?: string;
};

/**
 * A question the processor wants to ask the user or a vault-aware agent.
 * `options`, when present, constrains the answer to a multiple-choice pick;
 * absent means free-form. `idempotencyKey` de-dupes the question row on
 * processor retries. Optional `metadata` describes whether the uncertainty is
 * safe for an agent/model to resolve or should be escalated to the owner.
 */
export type QuestionEffect = {
  readonly kind: "question";
  readonly question: string;
  readonly options?: ReadonlyArray<string>;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
  readonly idempotencyKey: string;
  readonly metadata?: QuestionMetadata;
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
  readonly payload: JsonValue;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

/**
 * A recovery transition for a durable outbox row. Health/recovery processors
 * emit this after a user answers an operational question; the engine-owned
 * outbox sink applies the state-machine transition. This keeps failed-row
 * recovery behind Effect routing instead of giving processors direct SQLite
 * access.
 */
export type OutboxRecoveryEffect = {
  readonly kind: "outbox-recovery";
  readonly action: "retry" | "abandon";
  readonly idempotencyKey: string;
  readonly failureToken?: string;
  readonly reason: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

/**
 * A recovery transition for a quarantined processor trigger. Health/recovery
 * processors emit this after a user answers an operational question; the
 * engine-owned execution-state sink clears the matching quarantine entry.
 */
export type QuarantineRecoveryEffect = {
  readonly kind: "quarantine-recovery";
  readonly action: "reset";
  readonly phase: "adoption" | "garden" | "view";
  readonly processorId: string;
  readonly processorVersion: string;
  readonly triggerHash: string;
  readonly quarantineId: string;
  readonly quarantinedAt: string;
  readonly consecutiveRetryableFailures: number;
  readonly reason: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

/**
 * A recovery transition for a stuck running processor run. Health/recovery
 * processors emit this after a user answers an operational question; the
 * engine-owned ledger sink marks that exact running-row generation failed.
 */
export type RunRecoveryEffect = {
  readonly kind: "run-recovery";
  readonly action: "fail";
  readonly runId: string;
  readonly startedAt: string;
  readonly processorId: string;
  readonly processorVersion: string;
  readonly phase: "adoption" | "garden" | "view";
  readonly reason: string;
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
 * to guarantee every kind has a route. Adding another kind requires a
 * spec change; the codebase fails to compile until every route is added.
 */
export type Effect =
  | PatchEffect
  | DiagnosticEffect
  | FactEffect
  | SearchDocumentEffect
  | QuestionEffect
  | ExternalActionEffect
  | OutboxRecoveryEffect
  | QuarantineRecoveryEffect
  | RunRecoveryEffect
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

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);

export const ViewContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("markdown"), body: z.string() }).strict(),
  z
    .object({
      kind: z.literal("structured"),
      data: JsonValueSchema,
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

/**
 * `sourceRefs` must be non-empty ("no evidence, no durable claim", per
 * effects.md §"FactEffect") and `confidence` is required when `assertion`
 * is `inferred` or `generated`. Applied directly on `FactEffectSchema`;
 * zod 4's `discriminatedUnion` accepts refined members, so the union runs
 * the same refinement with no re-application layer.
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
      code: "custom",
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
      code: "custom",
      message:
        "FactEffect.confidence is required when assertion is 'inferred' or 'generated'",
      path: ["confidence"],
    });
  }
}

export const FactEffectSchema = z
  .object({
    kind: z.literal("fact"),
    subject: NodeRefSchema,
    predicate: z.string().min(1),
    object: z.union([NodeRefSchema, LiteralSchema]),
    assertion: z.enum(["explicit", "extracted", "inferred", "generated"]),
    sourceRefs: z.array(SourceRefSchema),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict()
  .superRefine(factEffectRefinements);

export const SearchDocumentEffectSchema = z
  .object({
    kind: z.literal("search-document"),
    operation: z.enum(["upsert", "delete"]),
    path: VaultPathSchema,
    sectionId: z.string().min(1).optional(),
    breadcrumb: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    body: z.string().optional(),
    sourceRefs: z.array(SourceRefSchema),
  })
  .strict()
  .superRefine(searchDocumentEffectRefinements);

function searchDocumentEffectRefinements(
  v: {
    readonly operation: "upsert" | "delete";
    readonly sectionId?: string | undefined;
    readonly breadcrumb?: string | undefined;
    readonly category?: string | undefined;
    readonly title?: string | undefined;
    readonly body?: string | undefined;
    readonly sourceRefs: ReadonlyArray<unknown>;
  },
  ctx: z.RefinementCtx,
): void {
  if (v.operation === "delete" && v.sectionId !== undefined) {
    ctx.addIssue({
      code: "custom",
      message:
        "SearchDocumentEffect.sectionId is only valid for upsert (delete clears every row for path)",
      path: ["sectionId"],
    });
  }
  if (v.operation === "delete" && v.breadcrumb !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "SearchDocumentEffect.breadcrumb is only valid for upsert",
      path: ["breadcrumb"],
    });
  }
  if (v.sourceRefs.length === 0) {
    ctx.addIssue({
      code: "custom",
      message:
        "SearchDocumentEffect.sourceRefs must be non-empty (search results need evidence)",
      path: ["sourceRefs"],
    });
  }
  if (v.operation === "upsert") {
    if (v.category === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "SearchDocumentEffect.category is required for upsert",
        path: ["category"],
      });
    }
    if (v.title === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "SearchDocumentEffect.title is required for upsert",
        path: ["title"],
      });
    }
    if (v.body === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "SearchDocumentEffect.body is required for upsert",
        path: ["body"],
      });
    }
  }
}

export const QuestionEffectSchema = z
  .object({
    kind: z.literal("question"),
    question: z.string().min(1),
    options: z.array(z.string().min(1)).optional(),
    sourceRefs: z.array(SourceRefSchema),
    idempotencyKey: z.string().min(1),
    metadata: z
      .object({
        risk: z.enum(["low", "medium", "high"]).optional(),
        confidence: z.number().min(0).max(1).optional(),
        recommendedAnswer: z.string().min(1).optional(),
        automationPolicy: z
          .enum(["agent-safe", "model-safe", "owner-needed"])
          .optional(),
        ownerNeededReason: z.string().min(1).optional(),
        destination: z.string().min(1).optional(),
        material: z.string().min(1).optional(),
        proposedSection: z.string().min(1).max(4000).optional(),
        subjectProcessorId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ExternalActionEffectSchema = z
  .object({
    kind: z.literal("external"),
    capability: z.string().min(1),
    idempotencyKey: z.string().min(1),
    payload: JsonValueSchema,
    sourceRefs: z.array(SourceRefSchema),
  })
  .strict();

export const OutboxRecoveryEffectSchema = z
  .object({
    kind: z.literal("outbox-recovery"),
    action: z.enum(["retry", "abandon"]),
    idempotencyKey: z.string().min(1),
    failureToken: z.string().min(1).optional(),
    reason: z.string().min(1),
    sourceRefs: z.array(SourceRefSchema),
  })
  .strict();

export const QuarantineRecoveryEffectSchema = z
  .object({
    kind: z.literal("quarantine-recovery"),
    action: z.literal("reset"),
    phase: z.enum(["adoption", "garden", "view"]),
    processorId: z.string().min(1),
    processorVersion: z.string().min(1),
    triggerHash: z.string().min(1),
    quarantineId: z.string().min(1),
    quarantinedAt: z.string().datetime(),
    consecutiveRetryableFailures: z.number().int().nonnegative(),
    reason: z.string().min(1),
    sourceRefs: z.array(SourceRefSchema),
  })
  .strict();

export const RunRecoveryEffectSchema = z
  .object({
    kind: z.literal("run-recovery"),
    action: z.literal("fail"),
    runId: z.string().min(1),
    startedAt: z.string().datetime(),
    processorId: z.string().min(1),
    processorVersion: z.string().min(1),
    phase: z.enum(["adoption", "garden", "view"]),
    reason: z.string().min(1),
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
 * Discriminated union over the ten effect kinds. Use this at engine
 * entry points (broker validation, sqlite reads). Not exported as the
 * inferred type — consumers should type from the `Effect` union to
 * preserve `exactOptionalPropertyTypes` semantics (see
 * tests/types/schema-type-lockstep.ts for the drift fence).
 *
 * Members carry their semantic refinements directly (zod 4's
 * `discriminatedUnion` accepts refined members), so
 * `<Kind>EffectSchema.parse(...)` and `EffectSchema.parse(...)` validate
 * identical constraints with no re-application layer.
 */
export const EffectSchema = z.discriminatedUnion("kind", [
  PatchEffectSchema,
  DiagnosticEffectSchema,
  FactEffectSchema,
  SearchDocumentEffectSchema,
  QuestionEffectSchema,
  ExternalActionEffectSchema,
  OutboxRecoveryEffectSchema,
  QuarantineRecoveryEffectSchema,
  RunRecoveryEffectSchema,
  ViewEffectSchema,
]);

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

export function searchDocumentEffect(
  input: SearchDocumentEffectInput,
): SearchDocumentEffect {
  if (input.operation === "upsert") {
    const e: {
      -readonly [K in keyof Extract<
        SearchDocumentEffect,
        { readonly operation: "upsert" }
      >]: Extract<SearchDocumentEffect, { readonly operation: "upsert" }>[K];
    } = {
      kind: "search-document",
      operation: "upsert",
      path: requireVaultPath(input.path, "SearchDocumentEffect.path"),
      category: input.category,
      title: input.title,
      body: input.body,
      sourceRefs: input.sourceRefs,
    };
    if (input.sectionId !== undefined) e.sectionId = input.sectionId;
    if (input.breadcrumb !== undefined) e.breadcrumb = input.breadcrumb;
    if (input.type !== undefined) e.type = input.type;
    return Object.freeze(e);
  }
  const e: {
    -readonly [K in keyof Extract<
      SearchDocumentEffect,
      { readonly operation: "delete" }
    >]: Extract<SearchDocumentEffect, { readonly operation: "delete" }>[K];
  } = {
    kind: "search-document",
    operation: "delete",
    path: requireVaultPath(input.path, "SearchDocumentEffect.path"),
    sourceRefs: input.sourceRefs,
  };
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
  if (input.metadata !== undefined) e.metadata = Object.freeze(input.metadata);
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

export function outboxRecoveryEffect(
  input: Omit<OutboxRecoveryEffect, "kind">,
): OutboxRecoveryEffect {
  const e: {
    -readonly [K in keyof OutboxRecoveryEffect]: OutboxRecoveryEffect[K];
  } = {
    kind: "outbox-recovery",
    action: input.action,
    idempotencyKey: input.idempotencyKey,
    reason: input.reason,
    sourceRefs: input.sourceRefs,
  };
  if (input.failureToken !== undefined) e.failureToken = input.failureToken;
  return Object.freeze(e);
}

export function quarantineRecoveryEffect(
  input: Omit<QuarantineRecoveryEffect, "kind">,
): QuarantineRecoveryEffect {
  const e: {
    -readonly [K in keyof QuarantineRecoveryEffect]: QuarantineRecoveryEffect[K];
  } = {
    kind: "quarantine-recovery",
    action: input.action,
    phase: input.phase,
    processorId: input.processorId,
    processorVersion: input.processorVersion,
    triggerHash: input.triggerHash,
    quarantineId: input.quarantineId,
    quarantinedAt: input.quarantinedAt,
    consecutiveRetryableFailures: input.consecutiveRetryableFailures,
    reason: input.reason,
    sourceRefs: input.sourceRefs,
  };
  return Object.freeze(e);
}

export function runRecoveryEffect(
  input: Omit<RunRecoveryEffect, "kind">,
): RunRecoveryEffect {
  const e: {
    -readonly [K in keyof RunRecoveryEffect]: RunRecoveryEffect[K];
  } = {
    kind: "run-recovery",
    action: input.action,
    runId: input.runId,
    startedAt: input.startedAt,
    processorId: input.processorId,
    processorVersion: input.processorVersion,
    phase: input.phase,
    reason: input.reason,
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
