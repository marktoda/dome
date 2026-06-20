// manifest-schema: Zod-validated parsing of a bundle's `manifest.yaml`.
//
// Per [[wiki/specs/capabilities]] §"Manifest schema" and
// [[wiki/specs/sdk-surface]] §"`manifest.yaml` schema", a bundle declares
// its identity (id, version) plus a list of processor declarations. Each
// declaration carries the processor's id, version, phase, triggers,
// capabilities, and the relative `module:` path of the TypeScript file
// exporting the processor implementation.
//
// This file provides:
//   - The `Manifest` / `ProcessorDeclaration` types (boundary shapes — the
//     loader imports the actual `Processor` module separately and binds the
//     declared metadata to the imported object).
//   - The Zod schema that validates a parsed YAML/JSON payload against the
//     declared shape.
//   - `parseManifest(input: unknown): Result<Manifest, ManifestError>` —
//     the never-throws boundary entry point.
//   - The phase × trigger compatibility check per
//     [[wiki/matrices/processor-phase-x-trigger]]. Layered on top of the
//     Zod shape check so the two failure modes surface as distinct error
//     kinds (the operator sees a structural-shape error vs. a matrix-
//     violation error separately).
//
// House-style notes (matches src/core/processor.ts, src/processors/registry.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Optional fields use `field?: T` (not `T | undefined`) for
//     `exactOptionalPropertyTypes` cleanliness.
//   - Zod object schemas use `.strict()` — unknown keys are validation
//     errors (manifest shape is closed; a typo'd field name is a defect).
//   - Schemas are not annotated as `z.ZodType<T>`: zod's `.optional()`
//     emits `T | undefined`, which collides with
//     `exactOptionalPropertyTypes`. Downstream code should type from the
//     `Manifest` / `ProcessorDeclaration` types, not `z.infer<...>`.
//   - Returns `Result<T, E>` — never throws on shape failures.

import { z } from "zod";

import { err, ok, type Result } from "../types";
import {
  CapabilitySchema,
  ExecutionPolicyRequestSchema,
  InspectionScopeSchema,
  ProcessorPhaseSchema,
  TriggerSchema,
  type Capability,
  type ExecutionPolicyRequest,
  type InspectionScope,
  type ProcessorPhase,
  type Trigger,
} from "../core/processor";

// ----- Public types ---------------------------------------------------------

/**
 * The validated manifest shape. `id` is the bundle's canonical identifier
 * (e.g., `dome.lint`); `version` is a semver string; `processors` is the
 * declared processor list (may be empty — a bundle that ships only
 * page-types or preamble fragments is valid).
 */
export type Manifest = {
  readonly id: string;
  readonly version: string;
  readonly processors: ReadonlyArray<ProcessorDeclaration>;
  /**
   * Bundle-scoped maintenance loops ([[wiki/specs/processors]] §"Maintenance
   * loops"). Required `processors` must be declared by this bundle (loops in
   * a manifest are self-contained); `optionalProcessors` may reference
   * foreign ids. Cross-bundle loops stay in the core registry by design.
   */
  readonly loops?: ReadonlyArray<ManifestLoopDeclaration>;
  /**
   * Doctor contributions ([[wiki/specs/cli]] §"dome doctor"): declarative
   * grant-entry requirements evaluated generically by the health report.
   * `processorId` must be declared by this bundle.
   */
  readonly doctor?: {
    readonly grantEntries: ReadonlyArray<ManifestGrantEntryRequirement>;
  };
};

/**
 * A declarative doctor probe: when the named processor is loaded and its
 * capability KIND is granted but the specific entry is not, `dome doctor`
 * raises `capability.grant-entry-missing` with this `why`/`recovery`.
 */
export type ManifestGrantEntryRequirement = {
  readonly processorId: string;
  readonly entries: ReadonlyArray<ManifestGrantEntry>;
  /** What silently breaks while the entry is missing. */
  readonly why: string;
  /** The exact .dome/config.yaml addition that satisfies the probe. */
  readonly recovery: string;
};

export type ManifestGrantEntry = {
  readonly kind: "read" | "patch.auto" | "graph.write";
  /** Vault path for path kinds; fact predicate for `graph.write`. */
  readonly target: string;
};

/** A maintenance-loop declaration inside a manifest. Settlement checks are
 * not declarable — every declared loop gets the standard five. */
export type ManifestLoopDeclaration = {
  readonly id: string;
  readonly goal: string;
  readonly evidence: ReadonlyArray<ManifestLoopEvidence>;
  readonly processors: ReadonlyArray<string>;
  readonly optionalProcessors?: ReadonlyArray<string>;
  readonly questionScope?: "processors" | "all";
  readonly surfaces: ReadonlyArray<ManifestLoopSurface>;
  readonly settlement: {
    readonly key: string;
    readonly noOpWhen: string;
  };
  readonly risks: ReadonlyArray<string>;
};

export type ManifestLoopEvidence =
  | { readonly kind: "path"; readonly pattern: string }
  | { readonly kind: "projection"; readonly name: string }
  | {
      readonly kind: "operational";
      readonly name:
        | "diagnostics"
        | "questions"
        | "runs"
        | "outbox"
        | "quarantines";
    };

export type ManifestLoopSurface =
  | { readonly kind: "path"; readonly pattern: string }
  | { readonly kind: "command"; readonly name: string }
  | { readonly kind: "projection"; readonly name: string }
  | { readonly kind: "status"; readonly name: "status" | "check" };

/**
 * A single processor declaration inside a manifest. `module` is the path of
 * the TypeScript file default-exporting the implementation object, relative
 * to the bundle root. The loader also accepts legacy full-Processor exports
 * for migration compatibility.
 */
export type ProcessorDeclaration = {
  readonly id: string;
  readonly version: string;
  readonly phase: ProcessorPhase;
  readonly triggers: ReadonlyArray<Trigger>;
  readonly capabilities: ReadonlyArray<Capability>;
  readonly execution?: ExecutionPolicyRequest;
  readonly inspection?: InspectionScope;
  readonly module: string;
};

/**
 * The closed set of manifest-validation failures. `invalid-shape` carries
 * the per-issue path + message list (from Zod) so the operator can fix
 * every drift in one pass; `phase-trigger-mismatch` carries the specific
 * (processorId, phase, triggerKind) tuple per
 * [[wiki/matrices/processor-phase-x-trigger]]; `execution-policy-mismatch`
 * carries the processor whose declared execution class is invalid for its
 * phase; `capability-phase-mismatch` carries capabilities that cannot be
 * granted in a declared phase.
 */
export type ManifestError =
  | {
      readonly kind: "invalid-shape";
      readonly issues: ReadonlyArray<{
        readonly path: string;
        readonly message: string;
      }>;
    }
  | {
      readonly kind: "phase-trigger-mismatch";
      readonly processorId: string;
      readonly phase: ProcessorPhase;
      readonly trigger: TriggerKind;
    }
  | {
      readonly kind: "execution-policy-mismatch";
      readonly processorId: string;
      readonly phase: ProcessorPhase;
      readonly executionClass: string;
    }
  | {
      readonly kind: "capability-phase-mismatch";
      readonly processorId: string;
      readonly phase: ProcessorPhase;
      readonly capability: string;
    }
  | {
      readonly kind: "capability-not-supported";
      readonly processorId: string;
      readonly capability: string;
      readonly message: string;
    }
  | {
      readonly kind: "loop-foreign-processor";
      readonly loopId: string;
      readonly processorId: string;
    }
  | {
      readonly kind: "duplicate-loop-id";
      readonly loopId: string;
    }
  | {
      readonly kind: "doctor-foreign-processor";
      readonly processorId: string;
    };

/** Closed set of trigger discriminators — the surface the matrix gates on. */
export type TriggerKind = "signal" | "path" | "schedule" | "answer" | "command";

// ----- Zod schemas ----------------------------------------------------------
//
// Not annotated as `z.ZodType<T>` because zod's `.optional()` emits
// `key?: T | undefined`, which collides with exactOptionalPropertyTypes.

export const ProcessorDeclarationSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    phase: ProcessorPhaseSchema,
    triggers: z.array(TriggerSchema).min(1),
    capabilities: z.array(CapabilitySchema),
    execution: ExecutionPolicyRequestSchema.optional(),
    inspection: InspectionScopeSchema.optional(),
    module: z.string().min(1),
  })
  .strict();

const ManifestLoopEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("path"), pattern: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("projection"), name: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("operational"),
      name: z.enum(["diagnostics", "questions", "runs", "outbox", "quarantines"]),
    })
    .strict(),
]);

const ManifestLoopSurfaceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("path"), pattern: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("command"), name: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("projection"), name: z.string().min(1) }).strict(),
  z
    .object({ kind: z.literal("status"), name: z.enum(["status", "check"]) })
    .strict(),
]);

export const ManifestLoopSchema = z
  .object({
    id: z.string().min(1),
    goal: z.string().min(1),
    evidence: z.array(ManifestLoopEvidenceSchema).min(1),
    processors: z.array(z.string().min(1)).min(1),
    optionalProcessors: z.array(z.string().min(1)).optional(),
    questionScope: z.enum(["processors", "all"]).optional(),
    surfaces: z.array(ManifestLoopSurfaceSchema).min(1),
    settlement: z
      .object({
        key: z.string().min(1),
        noOpWhen: z.string().min(1),
      })
      .strict(),
    risks: z.array(z.string().min(1)).min(1),
  })
  .strict();

const ManifestGrantEntrySchema = z
  .object({
    kind: z.enum(["read", "patch.auto", "graph.write"]),
    target: z.string().min(1),
  })
  .strict();

export const ManifestGrantEntryRequirementSchema = z
  .object({
    processorId: z.string().min(1),
    entries: z.array(ManifestGrantEntrySchema).min(1),
    why: z.string().min(1),
    recovery: z.string().min(1),
  })
  .strict();

export const ManifestSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    processors: z.array(ProcessorDeclarationSchema),
    loops: z.array(ManifestLoopSchema).optional(),
    doctor: z
      .object({
        grantEntries: z.array(ManifestGrantEntryRequirementSchema).min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

// ----- Phase × trigger compatibility ----------------------------------------
//
// Mirrors [[wiki/matrices/processor-phase-x-trigger]]. The canonical doc is
// the source of truth; this constant is the lockstep mirror the loader
// consults. Adding a phase or trigger kind requires updating both surfaces.
//
//   adoption: signal/path allowed; schedule/command rejected
//   garden:   signal/path/schedule/answer allowed; command rejected
//   view:     command allowed; signal/path/schedule/answer rejected

const ALLOWED_TRIGGERS_BY_PHASE: Readonly<Record<ProcessorPhase, ReadonlySet<TriggerKind>>> = {
  adoption: new Set<TriggerKind>(["signal", "path"]),
  garden: new Set<TriggerKind>(["signal", "path", "schedule", "answer"]),
  view: new Set<TriggerKind>(["command"]),
};

/**
 * Cross-field validation: every declared trigger's `kind` must be in the
 * phase's allowed set. Returns the first violation encountered (one error
 * per parse — the operator fixes one mismatch at a time and reruns).
 */
function checkPhaseTriggerMatrix(
  manifest: Manifest,
): Result<void, ManifestError> {
  for (const decl of manifest.processors) {
    const allowed = ALLOWED_TRIGGERS_BY_PHASE[decl.phase];
    for (const trigger of decl.triggers) {
      if (!allowed.has(trigger.kind)) {
        return err({
          kind: "phase-trigger-mismatch",
          processorId: decl.id,
          phase: decl.phase,
          trigger: trigger.kind,
        });
      }
    }
  }
  return ok(undefined);
}

/**
 * Cross-field validation: adoption is the fixed-point merge gate and must
 * stay deterministic. Longer-lived classes (`background`, `llm`, `batch`) are
 * valid only outside adoption.
 */
function checkExecutionPolicyMatrix(
  manifest: Manifest,
): Result<void, ManifestError> {
  for (const decl of manifest.processors) {
    if (
      decl.phase === "adoption" &&
      decl.execution !== undefined &&
      decl.execution.class !== "deterministic"
    ) {
      return err({
        kind: "execution-policy-mismatch",
        processorId: decl.id,
        phase: decl.phase,
        executionClass: decl.execution.class,
      });
    }
  }
  return ok(undefined);
}

/**
 * Cross-field validation: adoption runs inside the deterministic merge gate.
 * They cannot request model invocation, regardless of whether runtime policy
 * would later omit `ctx.modelInvoke`.
 */
function checkCapabilityPhaseMatrix(
  manifest: Manifest,
): Result<void, ManifestError> {
  for (const decl of manifest.processors) {
    if (
      decl.phase === "adoption" &&
      decl.capabilities.some((capability) => capability.kind === "model.invoke")
    ) {
      return err({
        kind: "capability-phase-mismatch",
        processorId: decl.id,
        phase: decl.phase,
        capability: "model.invoke",
      });
    }
  }
  return ok(undefined);
}

/**
 * Cross-field validation: a manifest loop is self-contained — every required
 * processor id must be declared by this bundle. Cross-bundle desired states
 * belong in the core composition registry, not a single bundle's manifest.
 * Also rejects duplicate loop ids within one manifest.
 */
function checkLoopDeclarations(
  manifest: Manifest,
): Result<void, ManifestError> {
  const declared = new Set(manifest.processors.map((decl) => decl.id));
  const seen = new Set<string>();
  for (const loop of manifest.loops ?? []) {
    if (seen.has(loop.id)) {
      return err({ kind: "duplicate-loop-id", loopId: loop.id });
    }
    seen.add(loop.id);
    for (const processorId of loop.processors) {
      if (!declared.has(processorId)) {
        return err({
          kind: "loop-foreign-processor",
          loopId: loop.id,
          processorId,
        });
      }
    }
  }
  return ok(undefined);
}

/**
 * Cross-field validation: doctor grant-entry requirements are
 * self-contained — the named processor must be declared by this bundle.
 */
function checkDoctorDeclarations(
  manifest: Manifest,
): Result<void, ManifestError> {
  const declared = new Set(manifest.processors.map((decl) => decl.id));
  for (const requirement of manifest.doctor?.grantEntries ?? []) {
    if (!declared.has(requirement.processorId)) {
      return err({
        kind: "doctor-foreign-processor",
        processorId: requirement.processorId,
      });
    }
  }
  return ok(undefined);
}

// ----- parseManifest --------------------------------------------------------

/**
 * Validate an arbitrary parsed-YAML / parsed-JSON payload against the
 * manifest schema. On success, returns a `Manifest` with normalized
 * structure; on failure, returns one of:
 *
 *   - `invalid-shape`: Zod rejected the structural shape. The `issues`
 *     array is one entry per per-field violation (Zod's `error.issues`
 *     dotted to a path string).
 *   - `phase-trigger-mismatch`: the shape parsed, but a processor's
 *     phase × trigger pair violates the matrix.
 *   - `execution-policy-mismatch`: the shape parsed, but a processor's
 *     execution metadata violates the phase policy.
 *   - `capability-phase-mismatch`: the shape parsed, but a processor's
 *     capability declaration violates the phase policy.
 *
 * Two passes (shape → matrix) on purpose: the operator should see the
 * structural-shape errors first (those block parsing entirely); only once
 * the shape is valid does the matrix check fire (otherwise we'd be
 * iterating over potentially-malformed declarations).
 */
export function parseManifest(
  input: unknown,
): Result<Manifest, ManifestError> {
  const shapeResult = ManifestSchema.safeParse(input);
  if (!shapeResult.success) {
    const issues = shapeResult.error.issues.map((issue) => ({
      path: issue.path.map((p) => String(p)).join("."),
      message: issue.message,
    }));
    return err({ kind: "invalid-shape", issues });
  }

  // The cast through `unknown` is required because zod (v4 included) infers
  // `key?: T | undefined` for optional fields (trigger.pathPattern,
  // capability.maxDailyCostUsd, etc.), which exactOptionalPropertyTypes
  // rejects against the `key?: T` Manifest type. The Zod parse already
  // validated the shape; the type-system gap here is purely
  // optional-property-presence semantics, not a real shape mismatch — and
  // the bidirectional fence in tests/types/schema-type-lockstep.ts keeps
  // this cast shape-safe (schema/type drift fails `bun run typecheck`).
  const manifest = shapeResult.data as unknown as Manifest;

  const matrixResult = checkPhaseTriggerMatrix(manifest);
  if (!matrixResult.ok) return err(matrixResult.error);

  const executionMatrixResult = checkExecutionPolicyMatrix(manifest);
  if (!executionMatrixResult.ok) return err(executionMatrixResult.error);

  const capabilityMatrixResult = checkCapabilityPhaseMatrix(manifest);
  if (!capabilityMatrixResult.ok) return err(capabilityMatrixResult.error);

  const loopResult = checkLoopDeclarations(manifest);
  if (!loopResult.ok) return err(loopResult.error);

  const doctorResult = checkDoctorDeclarations(manifest);
  if (!doctorResult.ok) return err(doctorResult.error);

  return ok(manifest);
}
