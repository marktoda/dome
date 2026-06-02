// ProcessorContext factory — the runtime-side assembler that packages the
// per-run inputs into the immutable `ProcessorContext<TInput>` shape a
// processor's `run()` method receives.
//
// See docs/wiki/specs/processors.md §"The Processor type" for the normative
// `ProcessorContext` shape (snapshot, changedPaths, proposal, runId, input,
// signal, capabilities token, optional modelInvoke, and the `sourceRef` helper).
//
// v1 Phase 3 scope:
//   - Pure factory. No filesystem, no git, no sqlite, no network. The runtime
//     hands in the already-assembled snapshot, the compile-range changed-paths
//     array, the originating Proposal (or null), the runId, the trigger
//     input, and the optional model-invoke handle; this factory wires them
//     into the frozen context object the processor sees.
//   - The `sourceRef` method on the returned context is *bound* to the
//     snapshot's commit — `ctx.sourceRef("wiki/x.md", { startLine: 1,
//     endLine: 5 })` returns a SourceRef anchored to `ctx.snapshot.commit`.
//     Processors that need to construct a SourceRef anchored to a different
//     commit (rare) import the `sourceRef(...)` helper from
//     `../core/source-ref` directly.
//   - The `CapabilityToken` is minted here as a single shared frozen sentinel.
//     The broker (`../engine/capability-broker`) reads grants from the
//     processor registry, not from the token; the token's purpose at v1 is
//     solely to make `ProcessorContext.capabilities` unambiguous in the type
//     system so processors cannot synthesize one. The sentinel is
//     module-private — callers receive it via `ctx.capabilities` only.
//   - `ProcessorContextInput<TInput>` has no `capabilities` field: callers
//     cannot forge a token, the factory mints it.
//
// House-style notes (matches src/core/source-ref.ts, src/core/effect.ts,
// src/processors/registry.ts, src/processors/triggers.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Optional fields use `field?: T` (not `T | undefined`) for
//     `exactOptionalPropertyTypes` cleanliness.
//   - Mutable-builder pattern (`{ -readonly [K in keyof X]: X[K] }`) so
//     `exactOptionalPropertyTypes` is honored when conditionally setting
//     `modelInvoke` — no `field: undefined` keys on the returned context.
//   - `Object.freeze` chosen over `as const` so misbehaving processors fail
//     loudly at runtime rather than silently mutating their context.
//   - Imports limited to pure types from `../core/processor`,
//     `../core/source-ref`, `../core/proposal`, plus the `sourceRef` value
//     helper from `../core/source-ref`. No engine-layer or runtime
//     dependencies — this factory is upstream of the processor invocation.

import type {
  CapabilityToken,
  ExtensionConfig,
  ModelInvokeFn,
  OperationalQueryView,
  ProcessorContext,
  ProjectionQueryView,
  Snapshot,
} from "../core/processor";
import type { PageTypeRegistry } from "../page-types";
import type { SourceRef, TextRange } from "../core/source-ref";
import { sourceRef } from "../core/source-ref";
import type { Proposal } from "../core/proposal";

// ----- ProcessorContextInput ------------------------------------------------

/**
 * The runtime's input to `makeProcessorContext`. Mirrors the
 * `ProcessorContext` shape minus the `capabilities` token (the factory mints
 * it; callers cannot forge one) and minus the `sourceRef` helper (the
 * factory builds it as a closure over `snapshot.commit`).
 *
 *   - `snapshot`     — the immutable tree at the candidate / adopted commit.
 *   - `changedPaths` — paths changed in base..candidate (the runtime may
 *                      pre-filter to the subset relevant to this processor;
 *                      this factory does not re-filter).
 *   - `proposal`     — the originating Proposal (adoption + garden-PatchEffect-
 *                      derived runs), or `null` (e.g., command runs).
 *   - `runId`        — matches the run ledger row's id.
 *   - `input`        — trigger-specific payload, typed by `TInput`.
 *   - `signal`       — runtime-owned cancellation signal for this invocation.
 *   - `modelInvoke`  — present iff the processor has the `model.invoke`
 *                      capability granted by the broker; the runtime decides
 *                      whether to pass it.
 *   - `operational`  — optional read-only operational state for recovery
 *                      processors; never a raw DB handle.
 */
export type ProcessorContextInput<TInput> = {
  readonly snapshot: Snapshot;
  readonly changedPaths: ReadonlyArray<string>;
  readonly proposal: Proposal | null;
  readonly runId: string;
  readonly input: TInput;
  readonly signal: AbortSignal;
  readonly canSourceRefPath?: (path: string) => boolean;
  readonly modelInvoke?: ModelInvokeFn;
  readonly operational?: OperationalQueryView;
  readonly pageTypes?: PageTypeRegistry;
  readonly extensionConfig?: ExtensionConfig;
  /**
   * Optional read-only projection query surface. View-phase invocations
   * pass a live `ProjectionQueryView` backed by the open projection
   * database; adoption-phase and garden-phase invocations omit it (those
   * processors read from `ctx.snapshot`).
   */
  readonly projection?: ProjectionQueryView;
};

// ----- CapabilityToken sentinel (module-private) ----------------------------

/**
 * The single shared frozen capability-token sentinel. Module-private — the
 * factory hands it out via `ctx.capabilities`, but callers cannot import or
 * construct one. Per processor.ts §"CapabilityToken", the token is
 * structurally opaque; the broker resolves grants from the registry, not
 * from the token itself, so a single sentinel suffices at v1.
 */
const CAPABILITY_TOKEN: CapabilityToken = Object.freeze({
  __brand: "CapabilityToken" as const,
}) as CapabilityToken;

const EMPTY_EXTENSION_CONFIG: ExtensionConfig = Object.freeze({});

// ----- makeProcessorContext -------------------------------------------------

/**
 * Build a frozen `ProcessorContext<TInput>` from the runtime's per-run
 * inputs. Pure factory — no I/O, no validation (the type system enforces the
 * input shape at the call site; the runtime validates the upstream sources).
 *
 * The returned `sourceRef` method pre-binds the snapshot's `commit`, so
 * `ctx.sourceRef("wiki/entities/danny.md", { startLine: 1, endLine: 5 })`
 * returns a SourceRef whose `commit` is `ctx.snapshot.commit`. Callers may
 * pass a third stable-id argument for generated regions or semantic tasks
 * whose identity should survive line moves. Thin wrapper around the core
 * `sourceRef(...)` helper.
 *
 * Optional `modelInvoke` is only assigned when defined, so the returned
 * context is `exactOptionalPropertyTypes`-clean (no `modelInvoke: undefined`
 * key when the capability was not granted).
 *
 * `Object.freeze` is applied to the returned context so a misbehaving
 * processor that tries to mutate `ctx.input`, `ctx.snapshot`, etc. fails
 * loudly at runtime.
 */
export function makeProcessorContext<TInput>(
  opts: ProcessorContextInput<TInput>,
): ProcessorContext<TInput> {
  const commit = opts.snapshot.commit;
  const boundSourceRef = (
    path: string,
    range?: TextRange,
    stableId?: string,
  ): SourceRef => {
    if (opts.canSourceRefPath?.(path) === false) {
      throw new Error(`sourceRef path is outside effective read grants: ${path}`);
    }
    return sourceRef({
      commit,
      path,
      ...(range !== undefined ? { range } : {}),
      ...(stableId !== undefined ? { stableId } : {}),
    });
  };

  const ctx: {
    -readonly [K in keyof ProcessorContext<TInput>]: ProcessorContext<TInput>[K];
  } = {
    snapshot: opts.snapshot,
    changedPaths: opts.changedPaths,
    proposal: opts.proposal,
    runId: opts.runId,
    input: opts.input,
    signal: opts.signal,
    capabilities: CAPABILITY_TOKEN,
    extensionConfig: opts.extensionConfig ?? EMPTY_EXTENSION_CONFIG,
    sourceRef: boundSourceRef,
  };
  if (opts.modelInvoke !== undefined) ctx.modelInvoke = opts.modelInvoke;
  if (opts.projection !== undefined) ctx.projection = opts.projection;
  if (opts.operational !== undefined) ctx.operational = opts.operational;
  if (opts.pageTypes !== undefined) ctx.pageTypes = opts.pageTypes;
  return Object.freeze(ctx);
}
