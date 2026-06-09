// Neutral home for the engine's outbound runner contracts. The engine layer
// owns these types (the engine consumes them as injection points); the
// processors layer implements them. This file exists to break the backward
// import that would otherwise force a processors → engine/adopt cycle when
// garden + view runners ship in Phase 4+.
//
// Living inside `src/engine/` (not `src/processors/`) reflects ownership: the
// engine's adoption / garden / view entry points consume these callbacks as
// injection points; the processors layer is the *implementer* of the
// contract, not its owner. Co-locating the contract with the consumers keeps
// the dependency arrow processors → engine and avoids the inverted import
// that lifted these types from `./adopt` in Phase 3.
//
// House-style notes (matches src/engine/compile-range.ts,
// src/engine/closure-commit.ts, src/engine/capability-broker.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Optional fields use `field?: T` (not `T | undefined`) for
//     `exactOptionalPropertyTypes` cleanliness.
//   - Pure type module: zero value exports, zero runtime imports. The
//     `Object.freeze`-over-`as const` convention that sibling engine files
//     follow does not apply here — no runtime values are produced.
//   - Imports limited to pure types from `../core/` (Effect, Capability,
//     Proposal, CommitOid) and the `SignalEvent` type from
//     `./compile-range`, plus the `EngineVault` type from `./vault-shape`.

import type { Effect } from "../core/effect";
import type { Capability, ProcessorPhase } from "../core/processor";
import type { Proposal } from "../core/proposal";
import type { CommitOid } from "../core/source-ref";
import type { SignalEvent } from "./compile-range";
import type { EngineVault } from "./vault-shape";

// ----- Branded RunId --------------------------------------------------------
//
// The engine ↔ runtime contract owns the run id brand. The processors runtime
// allocates ids (via `ledger/runs.newRunId`) and surfaces them on
// `RunnerResult.runId`; the engine threads them through `applyEffect` /
// `recordCapabilityUse` / `updateOutputCommit`; the ledger persists them.
// Living here (not in `../ledger/runs`) keeps the import arrow pointing from
// the ledger consumer toward the engine contract, not the other way around.
//
// Structurally branded so a raw `string` cannot accidentally flow into a slot
// expecting a RunId. The format is normative (per
// docs/wiki/specs/run-ledger.md §"Tables — runs":
// `run_<unix-ms>_<6-char-rand>`); the brand makes the lifecycle accessors
// refuse arbitrary strings.

/** A ledger run id, formatted `run_<unix-ms>_<6-char-rand>` per spec. */
export type RunId = string & { readonly __brand: "RunId" };

// ----- ProcessorExecutionError ---------------------------------------------

export type ProcessorExecutionErrorCode =
  | "processor.threw"
  | "processor.invalid-output"
  | "processor.timeout"
  | "processor.cancelled"
  | "model.invoke.denied"
  | "model.invoke.provider-failed"
  | "model.invoke.timeout"
  | "model.output.invalid-json"
  | "model.output.schema-mismatch";

export type ProcessorExecutionError = {
  readonly code: ProcessorExecutionErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly phase: ProcessorPhase;
  readonly processorId: string;
};

export type ProcessorExecutionErrorForCode<
  C extends ProcessorExecutionErrorCode,
> = Omit<ProcessorExecutionError, "code"> & { readonly code: C };

export type ProcessorFailedExecutionError =
  ProcessorExecutionErrorForCode<
    Exclude<
      ProcessorExecutionErrorCode,
      "processor.timeout" | "processor.cancelled"
    >
  >;

export type ProcessorTimeoutExecutionError =
  ProcessorExecutionErrorForCode<"processor.timeout">;

export type ProcessorCancelledExecutionError =
  ProcessorExecutionErrorForCode<"processor.cancelled">;

export type ProcessorSkippedExecutionErrorCode =
  | "execution-policy.phase-class-denied"
  | "processor.quarantined";

export type ProcessorSkippedExecutionError = {
  readonly code: ProcessorSkippedExecutionErrorCode;
  readonly message: string;
  readonly retryable: false;
  readonly phase: ProcessorPhase;
  readonly processorId: string;
  readonly class?: string;
};

export type RunnerError =
  | ProcessorExecutionError
  | ProcessorSkippedExecutionError;

// ----- RunnerExecutionStatus -----------------------------------------------

/**
 * Runtime terminal status surfaced to engine consumers alongside emitted
 * effects. This is deliberately separate from `effects`: processors may emit
 * a DiagnosticEffect whose code looks like an executor failure code, so engine
 * telemetry must not infer execution state by scanning arbitrary diagnostics.
 */
export type RunnerExecutionStatus =
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "skipped";

// ----- AdoptionPhaseRunner --------------------------------------------------

/**
 * The injected processor-runtime callback. The loop calls the runner once
 * per iteration with the candidate snapshot, the per-iteration changed-paths
 * delta, and the synthesized signals; the runner returns one record per
 * processor that fired, carrying the processor's id, its declared
 * capabilities, its effective granted capabilities, and the effects it
 * emitted.
 *
 * Phase 3 wires the actual processor-registry runner; Phase 2 accepts the
 * injection point so the loop is testable in isolation (a test passes a
 * stub callback returning predetermined records).
 *
 * Returning an empty array is the runner's signal that no processor fired
 * this iteration — the loop interprets it as "no effects produced" and
 * may reach a fixed point on the next no-patch check.
 */
export type AdoptionPhaseRunner = (input: {
  readonly vault: EngineVault;
  readonly candidate: CommitOid;
  readonly changedPaths: ReadonlyArray<string>;
  readonly signals: ReadonlyArray<SignalEvent>;
  readonly iteration: number;
  readonly proposal: Proposal;
  readonly signal?: AbortSignal;
}) => Promise<ReadonlyArray<RunnerResult>>;

// ----- ViewPhaseRunner ------------------------------------------------------

/**
 * The injected processor-runtime callback for view-phase processing.
 * Unlike adoption and garden, view phase is **command-driven** — there
 * is no signal stream. A caller (typically the CLI command dispatcher
 * or MCP `dome.run_command` tool) invokes `runViewCommand(name, args)`;
 * the runner finds the at-most-one view-phase processor whose triggers
 * declare `{ kind: "command", name: <name> }` and fires it with the
 * supplied args in `ctx.input`.
 *
 * Per [[wiki/specs/processors]] §"View phase" and Phase 4b in
 * [[cohesive/brainstorms/2026-05-27-v1-engine-completion]], view-phase
 * processors:
 *   - See the adopted snapshot (read-only).
 *   - Return `ViewEffect` (the rendered output) or no effects. Mutation
 *     effects (Patch / Diagnostic-block / Fact / Question / Job /
 *     External) are rejected by the broker as `phase-mismatch`.
 *   - Are at most one per command name (collision = registry-build failure
 *     with `duplicate-command-trigger`).
 *
 * Returns the matching processor's `RunnerResult` (or `null` when no
 * processor matches the command name). Schedule-triggered view
 * processors fire via Phase 4c's scheduler, not this entry point.
 */
export type ViewPhaseRunner = (input: {
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly commandName: string;
  readonly commandArgs: unknown;
  readonly signal?: AbortSignal;
}) => Promise<RunnerResult | null>;

// ----- GardenPhaseRunner ----------------------------------------------------

/**
 * The injected processor-runtime callback for garden-phase processing.
 * Garden runs **after** adoption completes successfully; the runner is
 * called once per adoption with the just-adopted commit, the signals
 * the adoption computed from `base..adopted`, and the original
 * proposal id (for ledger linkage). It returns one `RunnerResult` per
 * garden-phase processor that fired.
 *
 * Per [[wiki/specs/processors]] §"Garden phase" and the v1 engine
 * completion plan (Phase 4a in
 * [[cohesive/brainstorms/2026-05-27-v1-engine-completion]]), garden
 * processors:
 *
 *   - See the just-adopted snapshot (the new trusted state) — NOT a
 *     candidate snapshot, because garden runs after adoption finalized.
 *   - Match against the same `SignalEvent` set the adoption loop saw
 *     (computed from `base..adopted` via `compileRange`); the orchestrator
 *     passes them through.
 *   - May emit any Effect kind except ViewEffect (see
 *     [[wiki/matrices/effect-router-targets]] — view rows are rejected
 *     for garden phase). PatchEffect emissions from garden become
 *     **sub-Proposals**: the orchestrator constructs a new Proposal and
 *     routes it through `adopt()` recursively. Sub-Proposal recursion is
 *     bounded by a cascade-depth cap (see Phase 4a's planning notes).
 *
 * Schedule triggers do not fire through this signal/path runner; the
 * scheduler owns due cron dispatch. Answer triggers likewise fire through
 * the answer dispatcher after `dome resolve` / `dome answer` records a row.
 */
/**
 * Observability callback fired immediately before each garden-phase processor
 * is dispatched. The CLI's `onGardenProcessorStart` handler receives this and
 * prints a live "▶ running <processorId>" line so operators can see long-running
 * agents (llm-class) start rather than waiting for the after-the-fact summary.
 *
 * Engine code must not console.log — only CLI surfaces wire this callback.
 */
export type GardenProcessorStart = {
  readonly processorId: string;
  readonly executionClass?: string;
};

export type GardenPhaseRunner = (input: {
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly changedPaths: ReadonlyArray<string>;
  readonly signals: ReadonlyArray<SignalEvent>;
  readonly proposal: Proposal;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly onProcessorStart?: (info: GardenProcessorStart) => void;
}) => Promise<ReadonlyArray<RunnerResult>>;

/**
 * One per-processor record returned by the `AdoptionPhaseRunner` for an
 * iteration. The loop iterates `effects` and routes each through
 * `applyEffect` with the per-processor `(declared, granted)` so the broker
 * decision is correctly scoped.
 *
 * `runId` is the ledger run id allocated by the runtime when it dispatched
 * the processor. The engine threads it through `applyEffect` so the broker
 * records capability uses against the correct row — joining the
 * `capability_uses` and `runs` tables on this key (per
 * [[wiki/specs/run-ledger]] §"Tables — capability_uses"). When the runtime
 * is built without a ledger (the Phase 6 transitional state — see
 * `src/processors/runtime.ts`'s `BuildRuntimeOptions.ledger` slot), the
 * runtime synthesizes a placeholder id via `makeRunContext` so the engine
 * keeps its single-source-of-truth contract; nothing is recorded in that
 * case, but the type slot stays populated.
 */
export type RunnerResult = {
  readonly runId: RunId;
  readonly processorId: string;
  readonly executionStatus: RunnerExecutionStatus;
  readonly executionError?: RunnerError;
  readonly declared: ReadonlyArray<Capability>;
  readonly granted: ReadonlyArray<Capability>;
  /**
   * Paths this processor was allowed to inspect for this dispatch. The runtime
   * computes this as `changedPaths ∩ effective read grants`; projection
   * maintenance uses it when clearing stale page-scoped facts/diagnostics.
   */
  readonly inspectedPaths: ReadonlyArray<string>;
  readonly effects: ReadonlyArray<Effect>;
};
