// Processor: the typed function shape that every behavior in Dome implements.
// A processor takes a snapshot (immutable tree at a candidate or adopted
// commit) plus trigger-specific input and returns Effects. The engine routes
// the returned effects through capability enforcement, then applies them.
//
// See docs/wiki/specs/processors.md for the normative contract (the Processor
// type, the three phases, triggers and signals, capability tiers, idempotency,
// registration via `defineProcessor`). Capability tier shapes are normative in
// docs/wiki/specs/capabilities.md §"Capability tiers".
//
// Pure type definitions + Zod boundary schemas for static-data fields (triggers,
// capabilities, phase enum, signal enum, snapshot) + the `defineProcessor`
// type-narrowing identity helper. No runtime — the engine + processor runtime
// (Phase 2-3) implement against this type contract. No filesystem, sqlite, or
// git access.
//
// House-style notes (matches src/core/source-ref.ts, src/core/effect.ts, and
// src/core/proposal.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Optional fields use `field?: T` (not `T | undefined`) for
//     `exactOptionalPropertyTypes` cleanliness.
//   - Per-variant top-level type aliases unioned together (matches the
//     proposal.ts source-variant pattern and the effect.ts kind pattern).
//   - Zod object schemas use `.strict()` (unknown keys are validation
//     errors — Processor declarations are closed).
//   - Schemas are not annotated as `z.ZodType<T>`: zod's `.optional()`
//     emits `T | undefined`, which collides with
//     `exactOptionalPropertyTypes`. Downstream code should type from the
//     Processor/Trigger/Capability types, not `z.infer<...>`.
//   - No Zod schema for `Processor` or `ProcessorContext`: both carry
//     function fields (`run`, `sourceRef`, `modelInvoke`) that aren't
//     Zod-validatable. Static-data schemas (`TriggerSchema`,
//     `CapabilitySchema`, `SnapshotSchema`, etc.) ship for the
//     bundle-manifest loader.

import { z } from "zod";
import type {
  DiagnosticEffect,
  Effect,
  FactEffect,
  QuestionEffect,
} from "./effect";
import type { Proposal } from "./proposal";
import type { CommitOid, SourceRef, TextRange } from "./source-ref";

// ----- Branded OID alias ----------------------------------------------------
//
// Structurally branded (matches `CommitOid` / `BlobOid` in `./source-ref`).
// Use the `treeOid()` value helper below to brand an arbitrary string.

/** A 40-char hex SHA-1 identifying a git tree object. */
export type TreeOid = string & { readonly __brand: "TreeOid" };

/** Brand a raw string as a TreeOid. v1 enforces only non-empty via the type system. */
export function treeOid(s: string): TreeOid {
  return s as TreeOid;
}

// ----- Snapshot -------------------------------------------------------------

/**
 * An immutable view of the vault at a specific commit. `commit` is the
 * candidate commit being adopted (adoption phase) or the adopted commit
 * being read (garden / view phases); `tree` is the git tree OID at that
 * commit. Processors read blobs through `ctx.snapshot` rather than via
 * filesystem — the engine resolves reads against `tree`.
 *
 * `readFile` returns the blob's content as UTF-8 text, or `null` when the
 * path doesn't resolve to a blob inside the tree. `listMarkdownFiles`
 * returns every `.md` path in the tree (recursively); the runtime resolves
 * both against the git boundary in `../git`, so processors never touch the
 * filesystem directly.
 *
 * The read methods are function-valued (rather than data fields) so the
 * runtime can close over `(vaultPath, commit, tree)` and the processor's
 * call site stays a clean `await ctx.snapshot.readFile("wiki/x.md")`.
 */
export type Snapshot = {
  readonly commit: CommitOid;
  readonly tree: TreeOid;
  readonly readFile: (path: string) => Promise<string | null>;
  readonly listMarkdownFiles: () => Promise<ReadonlyArray<string>>;
};

// ----- ProcessorPhase -------------------------------------------------------

/**
 * The three execution phases. `adoption` runs inside the fixed-point loop
 * (bounded, deterministic, merge-blocking); `garden` runs after adoption
 * (async, possibly LLM-backed); `view` runs on demand (read-only).
 */
export type ProcessorPhase = "adoption" | "garden" | "view";

// ----- ExecutionPolicyRequest ----------------------------------------------

export type ExecutionClass =
  | "deterministic"
  | "interactive"
  | "background"
  | "llm"
  | "batch";

export type ExecutionPolicyRequest = {
  readonly class: ExecutionClass;
  readonly timeoutMs?: number;
  readonly retryBudgetMs?: number;
  readonly maxAttempts?: number;
  readonly modelCallTimeoutMs?: number;
};

// ----- Signal ---------------------------------------------------------------

/**
 * The closed set of engine-synthesized signals. The engine computes signals
 * once per Proposal from `compileRange(base, candidate)` and routes them to
 * subscribing processors. See processors.md §"Triggers and signals".
 */
export type Signal =
  | "file.created"
  | "file.modified"
  | "file.deleted"
  | "document.changed"
  | "frontmatter.changed"
  | "region.changed"
  | "link.added"
  | "link.removed";

// ----- Trigger --------------------------------------------------------------

/**
 * Per-kind Trigger variants. A processor declares one or more triggers; the
 * runtime fires the processor when any trigger matches. `signal` listens on
 * an engine-synthesized signal (optionally narrowed by a path glob); `path`
 * fires on any change to paths matching a glob; `schedule` fires on a cron
 * expression (garden phase only); `command` fires on a user-invoked CLI /
 * UI command (view phase only). Phase × trigger compatibility is at
 * docs/wiki/matrices/processor-phase-x-trigger.
 */
export type SignalTrigger = {
  readonly kind: "signal";
  readonly name: Signal;
  readonly pathPattern?: string;
};
export type PathTrigger = {
  readonly kind: "path";
  readonly pattern: string;
};
export type ScheduleTrigger = {
  readonly kind: "schedule";
  readonly cron: string;
};
export type CommandTrigger = {
  readonly kind: "command";
  readonly name: string;
};

export type Trigger =
  | SignalTrigger
  | PathTrigger
  | ScheduleTrigger
  | CommandTrigger;

// ----- Capability -----------------------------------------------------------

/**
 * Per-kind Capability variants. A processor declares its capabilities in its
 * bundle's `manifest.yaml`; the broker enforces the declared set against the
 * vault's policy at effect-emission time. See capabilities.md §"Capability
 * tiers" for the per-tier semantics.
 *
 *   - `read`          — read paths via `ctx.snapshot`; outside paths return null.
 *   - `patch.propose` — emit PatchEffect with `mode: "propose"`.
 *   - `patch.auto`    — emit PatchEffect with `mode: "auto"`.
 *   - `owns.region`   — exclusive write ownership of marker-delimited regions.
 *   - `owns.path`     — exclusive write ownership of whole files.
 *   - `graph.write`   — emit FactEffect under named namespaces.
 *   - `question.ask`  — emit QuestionEffect.
 *   - `job.enqueue`   — emit JobEffect targeting allowed processors.
 *   - `model.invoke`  — call `ctx.modelInvoke`; never granted to adoption phase.
 *   - `external`      — emit ExternalActionEffect with the named capability.
 */
export type ReadCapability = {
  readonly kind: "read";
  readonly paths: ReadonlyArray<string>;
};
export type PatchProposeCapability = {
  readonly kind: "patch.propose";
  readonly paths: ReadonlyArray<string>;
};
export type PatchAutoCapability = {
  readonly kind: "patch.auto";
  readonly paths: ReadonlyArray<string>;
};
export type OwnsRegionCapability = {
  readonly kind: "owns.region";
  readonly regionIds: ReadonlyArray<string>;
};
export type OwnsPathCapability = {
  readonly kind: "owns.path";
  readonly paths: ReadonlyArray<string>;
};
export type GraphWriteCapability = {
  readonly kind: "graph.write";
  readonly namespaces: ReadonlyArray<string>;
};
export type QuestionAskCapability = {
  readonly kind: "question.ask";
  readonly namespaces?: ReadonlyArray<string>;
};
export type JobEnqueueCapability = {
  readonly kind: "job.enqueue";
  readonly processors: ReadonlyArray<string>;
};
export type ModelInvokeCapability = {
  readonly kind: "model.invoke";
  readonly maxDailyCostUsd?: number;
  readonly modelAllowlist?: ReadonlyArray<string>;
};
export type ExternalCapability = {
  readonly kind: "external";
  readonly capability: string;
};

export type Capability =
  | ReadCapability
  | PatchProposeCapability
  | PatchAutoCapability
  | OwnsRegionCapability
  | OwnsPathCapability
  | GraphWriteCapability
  | QuestionAskCapability
  | JobEnqueueCapability
  | ModelInvokeCapability
  | ExternalCapability;

// ----- CapabilityToken ------------------------------------------------------

/**
 * Structurally opaque token passed to processors via `ProcessorContext`.
 * The engine constructs it (carrying the resolved grant set, the run id,
 * the processor id) and the broker reads it on effect emission. Processors
 * never construct or inspect it — the `__brand` field prevents accidental
 * forgery from arbitrary objects.
 */
export type CapabilityToken = { readonly __brand: "CapabilityToken" };

// ----- ModelInvokeFn --------------------------------------------------------

/**
 * Model-invocation signature available on `ProcessorContext` when the
 * processor declares and is granted `model.invoke`. The SDK core stays
 * provider-agnostic: callers inject a provider at the runtime boundary, and
 * processors consume a small text + structured JSON surface.
 */
export type ModelInvokeTextInput = {
  readonly prompt: string;
  readonly model?: string;
  readonly temperature?: number;
};

export type ModelInvokeStructuredInput<T> = ModelInvokeTextInput & {
  readonly schemaName: string;
  readonly parse: (value: unknown) => T;
  readonly retries?: number;
};

export type ModelInvokeFn = {
  (input: ModelInvokeTextInput): Promise<string>;
  readonly structured: <T>(
    input: ModelInvokeStructuredInput<T>,
  ) => Promise<T>;
};

// ----- ProjectionQueryView --------------------------------------------------

/**
 * The read-only query surface a view-phase processor uses to read from
 * the projection store (facts, diagnostics, questions). Per
 * docs/wiki/matrices/projection-table-x-owner.md §"Read access via the
 * query API", processors do NOT touch the SQLite handle directly —
 * they consume this typed surface.
 *
 * Adoption-phase processors typically read state from `ctx.snapshot`
 * (markdown content at the candidate commit) and the field stays
 * undefined on their context. View-phase processors require the
 * projection field — they answer queries by joining facts, diagnostics,
 * and committed markdown content.
 *
 * v1.0 scope is minimal — three accessors with light filters. Richer
 * shapes (FTS search, aggregate queries) land in later phases as
 * view-phase processors demand them.
 */
export type ProjectionQueryView = {
  /**
   * Read facts from the projection's `facts` table, filtered by any
   * combination of (predicate, subject). When all filter fields are
   * absent, every fact is returned (call sites are expected to bound
   * the result set themselves; v1 has no LIMIT clause).
   */
  readonly facts: (filter?: {
    readonly predicate?: string;
    readonly subjectKind?: "page" | "task" | "entity";
    readonly subjectId?: string;
  }) => ReadonlyArray<FactEffect>;

  /**
   * Read unresolved diagnostics, optionally filtered by severity or
   * processor id. Returns the full DiagnosticEffect shape — the
   * `sourceRefs` array is parsed back from JSON.
   */
  readonly diagnostics: (filter?: {
    readonly severity?: "info" | "warning" | "error" | "block";
    readonly processorId?: string;
  }) => ReadonlyArray<DiagnosticEffect>;

  /**
   * Read questions, optionally filtered by resolution status.
   */
  readonly questions: (filter?: {
    readonly resolved?: boolean;
  }) => ReadonlyArray<QuestionEffect>;
};

// ----- ProcessorContext -----------------------------------------------------

/**
 * The per-run context handed to a Processor's `run` method. Carries the
 * candidate snapshot, the changed-paths delta, the originating Proposal
 * (present for adoption + garden-PatchEffect-derived runs), the trigger
 * input (typed by the processor's `TInput` parameter), the cancellation
 * signal, the opaque capability token, the optional model-invoke handle
 * (present iff `model.invoke` capability granted), the optional projection query view
 * (present iff the runtime wired one — view-phase processors require it;
 * adoption-phase processors typically don't), and the `sourceRef` helper.
 *
 * `sourceRef` is modeled as a method (the spec uses method shorthand). In
 * `type X = { ... }` aliases the equivalent shape is a readonly function-
 * valued field; the type identity is the same.
 */
export type ProcessorContext<TInput = unknown> = {
  readonly snapshot: Snapshot;
  readonly changedPaths: ReadonlyArray<string>;
  readonly proposal: Proposal | null;
  readonly runId: string;
  readonly input: TInput;
  readonly signal: AbortSignal;
  readonly capabilities: CapabilityToken;
  readonly modelInvoke?: ModelInvokeFn;
  readonly projection?: ProjectionQueryView;
  readonly sourceRef: (path: string, range?: TextRange) => SourceRef;
};

// ----- Processor ------------------------------------------------------------

/**
 * The Processor contract. Every behavior Dome ships — first-party and
 * third-party alike — implements this shape. `run` takes the
 * `ProcessorContext` and returns Effects; the engine routes effects through
 * capability enforcement, then applies them. The engine deduplicates by
 * `(id, version, snapshotCommit, triggerHash)` in the run ledger, so `run`
 * must be idempotent (same `(snapshot, input)` → equivalent effects).
 *
 * `run` is modeled as a method (the spec uses method shorthand). In `type X
 * = { ... }` aliases the equivalent shape is a readonly function-valued
 * field; the type identity is the same.
 */
export type Processor<TInput = unknown> = {
  readonly id: string;
  readonly version: string;
  readonly phase: ProcessorPhase;
  readonly triggers: ReadonlyArray<Trigger>;
  readonly capabilities: ReadonlyArray<Capability>;
  readonly execution?: ExecutionPolicyRequest;
  readonly run: (ctx: ProcessorContext<TInput>) => Promise<ReadonlyArray<Effect>>;
};

// ----- Zod schemas ----------------------------------------------------------
// Boundary validation only — used by the bundle-manifest loader (Phase 3+)
// to validate processor declarations read from `manifest.yaml`. Function-
// bearing types (Processor, ProcessorContext) intentionally omitted: the
// engine constructs ProcessorContext at runtime, and the loader validates
// Processor's static-data fields via the per-field schemas exported here.
//
// Not annotated as `z.ZodType<T>` because zod's `.optional()` emits
// `key?: T | undefined`, which collides with exactOptionalPropertyTypes.

export const ProcessorPhaseSchema = z.enum(["adoption", "garden", "view"]);

export const ExecutionClassSchema = z.enum([
  "deterministic",
  "interactive",
  "background",
  "llm",
  "batch",
]);

export const ExecutionPolicyRequestSchema = z
  .object({
    class: ExecutionClassSchema,
    timeoutMs: z.number().int().positive().optional(),
    retryBudgetMs: z.number().int().nonnegative().optional(),
    maxAttempts: z.number().int().positive().optional(),
    modelCallTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const SignalSchema = z.enum([
  "file.created",
  "file.modified",
  "file.deleted",
  "document.changed",
  "frontmatter.changed",
  "region.changed",
  "link.added",
  "link.removed",
]);

export const SignalTriggerSchema = z
  .object({
    kind: z.literal("signal"),
    name: SignalSchema,
    pathPattern: z.string().min(1).optional(),
  })
  .strict();

export const PathTriggerSchema = z
  .object({
    kind: z.literal("path"),
    pattern: z.string().min(1),
  })
  .strict();

export const ScheduleTriggerSchema = z
  .object({
    kind: z.literal("schedule"),
    cron: z.string().min(1), // cron expression; loose v1 check (full grammar enforced upstream)
  })
  .strict();

export const CommandTriggerSchema = z
  .object({
    kind: z.literal("command"),
    name: z.string().min(1),
  })
  .strict();

export const TriggerSchema = z.discriminatedUnion("kind", [
  SignalTriggerSchema,
  PathTriggerSchema,
  ScheduleTriggerSchema,
  CommandTriggerSchema,
]);

export const ReadCapabilitySchema = z
  .object({
    kind: z.literal("read"),
    paths: z.array(z.string().min(1)),
  })
  .strict();

export const PatchProposeCapabilitySchema = z
  .object({
    kind: z.literal("patch.propose"),
    paths: z.array(z.string().min(1)),
  })
  .strict();

export const PatchAutoCapabilitySchema = z
  .object({
    kind: z.literal("patch.auto"),
    paths: z.array(z.string().min(1)),
  })
  .strict();

export const OwnsRegionCapabilitySchema = z
  .object({
    kind: z.literal("owns.region"),
    regionIds: z.array(z.string().min(1)),
  })
  .strict();

export const OwnsPathCapabilitySchema = z
  .object({
    kind: z.literal("owns.path"),
    paths: z.array(z.string().min(1)),
  })
  .strict();

export const GraphWriteCapabilitySchema = z
  .object({
    kind: z.literal("graph.write"),
    namespaces: z.array(z.string().min(1)),
  })
  .strict();

export const QuestionAskCapabilitySchema = z
  .object({
    kind: z.literal("question.ask"),
    namespaces: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const JobEnqueueCapabilitySchema = z
  .object({
    kind: z.literal("job.enqueue"),
    processors: z.array(z.string().min(1)),
  })
  .strict();

export const ModelInvokeCapabilitySchema = z
  .object({
    kind: z.literal("model.invoke"),
    maxDailyCostUsd: z.number().nonnegative().optional(),
    modelAllowlist: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const ExternalCapabilitySchema = z
  .object({
    kind: z.literal("external"),
    capability: z.string().min(1),
  })
  .strict();

export const CapabilitySchema = z.discriminatedUnion("kind", [
  ReadCapabilitySchema,
  PatchProposeCapabilitySchema,
  PatchAutoCapabilitySchema,
  OwnsRegionCapabilitySchema,
  OwnsPathCapabilitySchema,
  GraphWriteCapabilitySchema,
  QuestionAskCapabilitySchema,
  JobEnqueueCapabilitySchema,
  ModelInvokeCapabilitySchema,
  ExternalCapabilitySchema,
]);

// SnapshotSchema validates only the data fields (commit, tree); the read
// methods (`readFile`, `listMarkdownFiles`) are function-valued and aren't
// Zod-validatable. `.strict()` is intentionally relaxed here (`.passthrough`)
// because runtime-constructed Snapshots carry the function fields the schema
// can't describe — consumers that want a typed Snapshot should use the
// `Snapshot` type alias, not `z.infer<typeof SnapshotSchema>`.
export const SnapshotSchema = z
  .object({
    commit: z.string().min(1), // CommitOid; loose v1 check (40-char hex enforced upstream)
    tree: z.string().min(1), // TreeOid; loose v1 check (40-char hex enforced upstream)
  })
  .passthrough();

// ----- defineProcessor ------------------------------------------------------

/**
 * The canonical processor constructor. A type-narrowing identity function so
 * type inference works correctly at the call site (the generic `TInput`
 * threads through `ctx.input` in the user's `run`).
 *
 * Object.freeze chosen over `as const` so misbehaving processors fail loudly
 * at runtime rather than silently corrupting facts.
 */
export function defineProcessor<TInput = unknown>(
  processor: Processor<TInput>,
): Processor<TInput> {
  return Object.freeze(processor);
}
