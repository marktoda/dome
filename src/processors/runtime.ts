// ProcessorRuntime: the adapter that satisfies the engine's adoption,
// garden, and view runner contracts by walking the loaded
// `ProcessorRegistry`, matching triggers, packaging a `ProcessorContext`
// via `makeProcessorContext`, invoking processors through the executor
// boundary, and collecting one `RunnerResult` per firing processor.
//
// See docs/wiki/specs/processors.md §"The three phases" + §"Triggers and
// signals" + §"Run ledger" for the operational contract this runtime
// implements, and docs/wiki/specs/adoption.md §"The fixed-point adoption
// loop" for the call site (`src/engine/adopt.ts`'s `runAdoptionProcessors`
// injection point).
//
// v1 runtime scope (intentional simplifications, documented per the phase
// plan):
//
//   - Adoption, garden, and view runners ship. Adoption/garden use matched
//     signal/path trigger envelopes; view uses command envelopes.
//   - The processor input is a uniform phase envelope (for adoption/garden,
//     `{ kind, matchedTriggers }`). Per-processor `TInput` specialization is
//     a future refinement.
//   - Tree-OID resolution is injected at `buildRuntime` time via the
//     `resolveTree` callback (kept injected for testability + symmetry with
//     the per-iteration resolve site). Phase 11d adds direct `../git`
//     imports (`readBlob` / `readTree`) wired through the Snapshot's read
//     closures — adoption-phase processors need to read blob content +
//     enumerate the candidate tree to do their work, and the runtime is
//     where that boundary is constructed. The git imports are only
//     exercised lazily via the closure call sites.
//   - `model.invoke` is never wired on adoption-phase contexts (per
//     processors.md §"Adoption phase — bounded, deterministic,
//     merge-blocking" — adoption-phase processors never receive a model
//     handle). The factory's `modelInvoke` slot is left unset.
//   - Processor execution is delegated through `executeProcessor`, which
//     validates output, enforces execution policy, and turns terminal
//     failures into diagnostics without crashing the loop. Successful runs
//     persist effect hashes; failed / timed_out / cancelled runs persist
//     structured errors; pre-run policy denial is recorded as skipped with
//     a structured not-invoked reason.
//
// House-style notes (matches src/processors/registry.ts,
// src/processors/triggers.ts, src/processors/context.ts):
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Optional fields use `field?: T` (not `T | undefined`) for
//     `exactOptionalPropertyTypes` cleanliness.
//   - `Object.freeze` chosen over `as const` so misbehaving callers fail
//     loudly at runtime rather than silently mutating runner outputs.
//   - Imports limited to: `../core/effect` (`diagnosticEffect` helper),
//     `../core/processor` (Processor +
//     Capability + Snapshot + TreeOid types), `../core/source-ref`
//     (CommitOid), `../engine/runner-contract` (AdoptionPhaseRunner +
//     RunnerResult — the neutral home for the engine's outbound runner
//     contract that this runtime implements), `../ledger/db` (LedgerDb
//     handle type), `../ledger/runs` (insertQueued / markRunning /
//     markSucceeded / markFailed / markTimedOut / markCancelled /
//     markSkipped / newRunId + RunId & TriggerKind types — the per-run
//     ledger writes pinned by
//     EVERY_PROCESSOR_RUN_IS_LEDGERED), `./registry` (ProcessorRegistry),
//     `./triggers` (matchTriggers + TriggerMatch), `./context`
//     (makeProcessorContext + ProcessorContextInput), `./executor`
//     (executeProcessor), `./execution-policy` (resolveExecutionPolicy),
//     `../run-context` (makeRunContext — the no-ledger fallback for
//     runner-result runId). The `../git` import
//     surfaces `readBlob` / `readTree` for the Snapshot's read closures
//     (`readFile`, `listMarkdownFiles`); the closures are lazy — invoked
//     only when an adoption-phase processor reads from `ctx.snapshot` —
//     so runtimes whose processors don't touch the snapshot incur no git
//     I/O. The ledger handle's SQLite I/O is owned by `src/ledger/`.

import { posix } from "node:path";

import { diagnosticEffect } from "../core/effect";
import type {
  Capability,
  Processor,
  ProcessorContext,
  ProjectionQueryView,
  Snapshot,
  TreeOid,
} from "../core/processor";
import type { Proposal } from "../core/proposal";
import type { CommitOid } from "../core/source-ref";
import { readBlob, readTree } from "../git";
import type {
  AdoptionPhaseRunner,
  GardenPhaseRunner,
  ProcessorSkippedExecutionError,
  RunnerResult,
  ViewPhaseRunner,
} from "../engine/runner-contract";
import type { LedgerDb } from "../ledger/db";
import {
  executeProcessor,
  type ProcessorExecutionResult,
} from "./executor";
import {
  buildProcessorExecutionState,
  processorExecutionKey,
  type ProcessorExecutionState,
  type ProcessorExecutionKey,
} from "./execution-state";
import {
  resolveExecutionPolicy,
  type ExecutionPolicyError,
  type ResolvedExecutionPolicy,
} from "./execution-policy";
import {
  insertQueued,
  markCancelled,
  markFailed,
  markRunning,
  markSkipped,
  markSucceeded,
  markTimedOut,
  newRunId,
  type RunId,
  type TriggerKind,
} from "../ledger/runs";
import type { ProcessorRegistry } from "./registry";
import { matchTriggers, type TriggerMatch } from "./triggers";
import {
  makeProcessorContext,
  type ProcessorContextInput,
} from "./context";
import { makeRunContext } from "../run-context";
import {
  modelInvokeForProcessor,
  type ModelProvider,
} from "../engine/model-invoke";
import {
  filterReadablePaths,
  readablePath,
} from "../engine/path-capabilities";

// ----- AdoptionRunInput -----------------------------------------------------

/**
 * The uniform envelope every adoption-phase processor sees as `ctx.input`
 * during a Phase 3 runtime dispatch. `matchedTriggers` lists the (non-empty)
 * subset of the processor's declared triggers that fired, each annotated
 * with the SignalEvents that caused the match.
 *
 * Per-processor `TInput` specialization (e.g., a dome.index processor seeing
 * an index-update payload rather than a raw `TriggerMatch[]`) is a Phase 4+
 * refinement. For v1, the envelope is uniform across all adoption-phase
 * processors — the processor is responsible for inspecting
 * `ctx.input.matchedTriggers` if it cares which trigger fired.
 */
export type AdoptionRunInput = {
  readonly kind: "adoption";
  readonly matchedTriggers: ReadonlyArray<TriggerMatch>;
};

// ----- GardenRunInput -------------------------------------------------------

/**
 * The uniform envelope every garden-phase processor sees as `ctx.input`
 * during a Phase 4a runtime dispatch. `matchedTriggers` lists the (non-empty)
 * subset of the processor's declared triggers that fired against the
 * post-adoption signal stream, each annotated with the SignalEvents that
 * caused the match.
 *
 * Symmetric with `AdoptionRunInput` — the `kind` field is the only
 * structural difference, letting downstream processors branch on phase if
 * they handle both adoption and garden invocations (rare; most processors
 * declare a single phase).
 *
 * The orchestrator at `src/engine/garden.ts` constructs the envelope from
 * the gardenRunner's matched-triggers output; processors that care about
 * which trigger fired inspect `ctx.input.matchedTriggers`.
 */
export type GardenRunInput = {
  readonly kind: "garden";
  readonly matchedTriggers: ReadonlyArray<TriggerMatch>;
};

// ----- ViewRunInput ---------------------------------------------------------

/**
 * The envelope every view-phase processor sees as `ctx.input` during a
 * command-driven dispatch. Carries the command name (so a processor that
 * declares multiple `command:` triggers can branch on which one fired)
 * and the caller-supplied args (passed through verbatim from
 * `runViewCommand`'s caller — typically the CLI dispatcher or MCP
 * `dome.run_command` tool).
 *
 * View phase is command-driven (and, in Phase 4c, schedule-driven);
 * unlike adoption and garden, there is no signal stream, so
 * `matchedTriggers` is omitted — the command name uniquely identifies
 * the trigger that fired.
 */
export type ViewRunInput = {
  readonly kind: "view";
  readonly commandName: string;
  readonly commandArgs: unknown;
};

// ----- ProcessorRuntime -----------------------------------------------------

/**
 * The handle returned by `buildRuntime`. Carries the per-phase runner
 * callbacks the engine's adoption / garden / view entry points consume.
 *
 * Shipped as of Phase 4b: all three runners (adoption + garden + view).
 */
export type ProcessorRuntime = {
  readonly adoptionRunner: AdoptionPhaseRunner;
  readonly gardenRunner: GardenPhaseRunner;
  readonly viewRunner: ViewPhaseRunner;
  readonly executionState: ProcessorExecutionState;
};

// ----- BuildRuntimeOptions --------------------------------------------------

/**
 * The injected dependencies `buildRuntime` requires. `registry` is the
 * loaded ProcessorRegistry; `resolveGrants` returns the broker-resolved
 * grant set for a given processor id (typically derived from the vault's
 * capability policy against the bundle manifest); `extensionIdFor` maps a
 * processor id to its originating bundle id (for the `Dome-Extension`
 * trailer on engine commits via `makeRunContext`); `resolveTree` resolves
 * a candidate commit OID to its tree OID (the per-iteration Snapshot the
 * processor reads from).
 *
 * `resolveTree` is injected (rather than imported from `../git`) so this
 * runtime file stays I/O-free at the type layer. Whoever calls
 * `buildRuntime` (today: `src/vault.ts` or a future processors/index.ts)
 * wires the resolver against the live git boundary.
 */
export type BuildRuntimeOptions = {
  readonly registry: ProcessorRegistry;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly resolveTree: (commit: CommitOid) => Promise<TreeOid>;
  /**
   * Optional run-ledger handle. When present, every dispatched processor
   * lands one row in `runs` per [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]
   * §"Structural enforcement": `insertQueued` before policy resolution,
   * `markSkipped` for pre-run policy denial, `markRunning` before executor
   * invocation, and exactly one terminal mark (`succeeded`, `failed`,
   * `timed_out`, or `cancelled`) after executor completion.
   *
   * Optional during the Phase 6 transition: existing call sites
   * (`tests/processors/runtime.test.ts`, the to-be-wired `src/vault.ts`)
   * continue to operate without a ledger; Phase 7+ wires the live handle
   * end-to-end. When absent, no ledger writes occur and the runner-result
   * `runId` falls back to a `makeRunContext`-synthesized placeholder so
   * downstream `applyEffect` capability-use recording still has a slot
   * (the engine's adoption loop skips ledger writes if the ledger itself
   * is absent at its own seam).
   */
  readonly ledger?: LedgerDb;
  /**
   * Optional read-only projection query surface. When present, view-phase
   * processor invocations populate `ctx.projection` so command-triggered
   * views can read `dome.graph.links_to` facts, diagnostics, and questions
   * out of the projection store. Adoption-phase and garden-phase
   * invocations never receive the handle — those processors read state
   * via `ctx.snapshot` from the candidate / adopted tree.
   *
   * Optional because tests that exercise only the adoption / garden runners
   * (e.g., `tests/processors/runtime.test.ts`) don't need to wire a
   * projection view. The composed runtime built by
   * `src/engine/vault-runtime.ts` populates this against the open
   * `ProjectionDb`.
   */
  readonly projection?: ProjectionQueryView;
  readonly executionState?: ProcessorExecutionState;
  readonly modelProvider?: ModelProvider;
};

// ----- buildRuntime ---------------------------------------------------------

/**
 * Build a frozen `ProcessorRuntime` handle. The returned `adoptionRunner`
 * satisfies the engine's `AdoptionPhaseRunner` contract: given the
 * per-iteration `(candidate, changedPaths, signals, iteration, proposal,
 * vault)` tuple, it walks the registry's adoption-phase processors, fires
 * each whose triggers match the signals, constructs a `ProcessorContext`,
 * invokes the executor boundary, and returns one `RunnerResult` per firing
 * processor.
 *
 * Per-processor terminal failures are converted into diagnostics by the
 * executor boundary. The loop does not crash on a single misbehaving
 * processor.
 *
 * Returned values are frozen: the outer results array, each `RunnerResult`,
 * and each effect list are `Object.freeze`d so downstream consumers (the
 * adoption loop, test mocks) cannot mutate the runner's output.
 */
export function buildRuntime(opts: BuildRuntimeOptions): ProcessorRuntime {
  const {
    registry,
    resolveGrants,
    extensionIdFor,
    resolveTree,
    ledger,
    projection,
    modelProvider,
  } = opts;
  const executionState =
    opts.executionState ?? buildProcessorExecutionState();

  const adoptionRunner: AdoptionPhaseRunner = async (input) => {
    const adoptionProcessors = registry.byPhase("adoption");
    if (adoptionProcessors.length === 0) {
      return Object.freeze([]);
    }

    const snapshot = await makeSnapshot(
      input.vault.path,
      input.candidate,
      resolveTree,
    );

    const results: RunnerResult[] = [];
    for (const processor of adoptionProcessors) {
      const matches = matchTriggers(processor.triggers, input.signals);
      if (matches.length === 0) continue;

      const result = await dispatchOneProcessor({
        processor,
        phase: "adoption",
        envelope: Object.freeze({
          kind: "adoption" as const,
          matchedTriggers: matches,
        }),
        snapshot,
        changedPaths: input.changedPaths,
        proposal: input.proposal,
        inputCommit: input.candidate,
        matches,
        resolveGrants,
        extensionIdFor,
        ledger,
        executionState,
        ...(modelProvider !== undefined ? { modelProvider } : {}),
      });
      results.push(result);
    }

    return Object.freeze(results);
  };

  const gardenRunner: GardenPhaseRunner = async (input) => {
    const gardenProcessors = registry.byPhase("garden");
    if (gardenProcessors.length === 0) {
      return Object.freeze([]);
    }

    // Garden's Snapshot is built against the **adopted** commit — the
    // new trusted state — not a candidate. Same closures, different
    // commit. Processors read from this snapshot via `ctx.snapshot`.
    const snapshot = await makeSnapshot(
      input.vault.path,
      input.adopted,
      resolveTree,
    );

    const results: RunnerResult[] = [];
    for (const processor of gardenProcessors) {
      const matches = matchTriggers(processor.triggers, input.signals);
      if (matches.length === 0) continue;

      const result = await dispatchOneProcessor({
        processor,
        phase: "garden",
        envelope: Object.freeze({
          kind: "garden" as const,
          matchedTriggers: matches,
        }),
        snapshot,
        changedPaths: input.changedPaths,
        proposal: input.proposal,
        // `inputCommit` for garden is the adopted commit — the snapshot
        // the processor read from. This is what lands in
        // `runs.input_commit` for the audit trail; it joins to the
        // closure commit of the adoption that just completed.
        inputCommit: input.adopted,
        matches,
        resolveGrants,
        extensionIdFor,
        ledger,
        executionState,
        ...(modelProvider !== undefined ? { modelProvider } : {}),
      });
      results.push(result);
    }

    return Object.freeze(results);
  };

  const viewRunner: ViewPhaseRunner = async (input) => {
    const viewProcessors = registry.byPhase("view");
    if (viewProcessors.length === 0) {
      return null;
    }

    // Find the view-phase processor whose triggers include
    // `{ kind: "command", name: input.commandName }`. Per
    // [[wiki/specs/sdk-surface]] §"Bundle-loader error taxonomy"
    // §`cli-command-collision`, only one view-phase processor per
    // command name is allowed; the bundle loader rejects collisions at
    // load time. So `find` (not `filter`) is correct — at most one
    // match exists.
    const processor = viewProcessors.find((p) =>
      p.triggers.some(
        (t) => t.kind === "command" && t.name === input.commandName,
      ),
    );
    if (processor === undefined) {
      return null;
    }
    const matchedTrigger = processor.triggers.find(
      (t) => t.kind === "command" && t.name === input.commandName,
    );
    if (matchedTrigger === undefined) {
      // Defensive: the outer `find` already guarantees this, but
      // `noUncheckedIndexedAccess` wants the explicit guard.
      return null;
    }

    const snapshot = await makeSnapshot(
      input.vault.path,
      input.adopted,
      resolveTree,
    );

    // Synthesize a one-element TriggerMatch list for the dispatcher.
    // View commands have no signal events; `matchedSignals` is empty.
    const matches: ReadonlyArray<TriggerMatch> = Object.freeze([
      Object.freeze({
        trigger: matchedTrigger,
        matchedSignals: Object.freeze([]) as ReadonlyArray<never>,
      }),
    ] as unknown as TriggerMatch[]);

    return dispatchOneProcessor({
      processor,
      phase: "view",
      envelope: Object.freeze({
        kind: "view" as const,
        commandName: input.commandName,
        commandArgs: input.commandArgs,
      }),
      snapshot,
      // View runs don't have a base..head delta the way adoption /
      // garden do. `changedPaths` is empty; processors that need to
      // walk the adopted snapshot use `ctx.snapshot.listMarkdownFiles`.
      changedPaths: Object.freeze([]),
      // View runs are not proposal-anchored. The ledger row's
      // proposal_id is NULL.
      proposal: null,
      // The adopted commit is the "input" for ledger purposes (the
      // snapshot the processor read from). This is what
      // `runs.input_commit` records for view-phase rows.
      inputCommit: input.adopted,
      matches,
      resolveGrants,
      extensionIdFor,
      ledger,
      executionState,
      ...(modelProvider !== undefined ? { modelProvider } : {}),
      // View-phase processors receive the projection query view so they
      // can read facts / diagnostics / questions out of the projection
      // store via `ctx.projection`. Adoption + garden phases do NOT pass
      // the handle — those processors read state from `ctx.snapshot`.
      // Conditional spread keeps the call site exactOptionalPropertyTypes-
      // clean when no projection is wired (e.g., test harnesses that build
      // a runtime without projection).
      ...(projection !== undefined ? { projection } : {}),
    });
  };

  return Object.freeze({
    adoptionRunner,
    gardenRunner,
    viewRunner,
    executionState,
  });
}

// ----- shared dispatch helpers ----------------------------------------------

/**
 * Build the per-iteration Snapshot. Resolves the tree OID once per
 * (vaultPath, commit) pair; the read closures (`readFile`,
 * `listMarkdownFiles`) bind lazily so processors that don't touch the
 * snapshot incur no git I/O.
 *
 * Used by both `adoptionRunner` (commit = candidate) and `gardenRunner`
 * (commit = adopted). Identical shape; the only variation is which commit
 * the closures resolve against.
 */
export async function makeSnapshot(
  vaultPath: string,
  commit: CommitOid,
  resolveTree: (commit: CommitOid) => Promise<TreeOid>,
): Promise<Snapshot> {
  const tree = await resolveTree(commit);
  return Object.freeze({
    commit,
    tree,
    readFile: (path: string) =>
      readBlob({ path: vaultPath, commit, filepath: path }),
    listMarkdownFiles: () => listMarkdownPathsInTree(vaultPath, commit),
  });
}

/**
 * Per-processor dispatch — shared by adoption, garden, view, scheduler, and
 * job dispatch.
 * Handles run-id allocation, ledger lifecycle (queued → skipped for
 * not-invoked policy denial, or queued → running → succeeded/failed/
 * timed_out/cancelled), context construction, executor invocation, and
 * RunnerResult assembly. Executor terminal failures return diagnostics to
 * the engine while structured errors land in the run ledger.
 *
 * The only per-phase variation in this lifecycle is the `phase` value
 * stored in the ledger row and the `envelope` shape passed as
 * `ctx.input`. Both are parameters here; the body is identical
 * otherwise. Centralizing the dispatch keeps callers focused on
 * phase-specific filtering, snapshot choice, and envelope construction; the
 * audit lifecycle (the load-bearing
 * [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]] contract) is
 * structurally identical across phases.
 */
export type DispatchOneProcessorOptions<TEnvelope> = {
  readonly processor: Processor<unknown>;
  readonly phase: "adoption" | "garden" | "view";
  readonly envelope: TEnvelope;
  readonly snapshot: Snapshot;
  readonly changedPaths: ReadonlyArray<string>;
  readonly proposal: Proposal | null;
  readonly inputCommit: CommitOid;
  readonly matches: ReadonlyArray<TriggerMatch>;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly ledger: LedgerDb | undefined;
  readonly executionState?: ProcessorExecutionState;
  readonly modelProvider?: ModelProvider;
  /**
   * The projection query view to thread onto `ctx.projection`. Only the
   * view-phase caller passes this; adoption + garden callers leave it
   * undefined so their processors see `ctx.projection === undefined` (they
   * read state from `ctx.snapshot`, not from the projection store).
   *
   * Defensively, even when the caller mistakenly passes a projection on
   * an adoption / garden dispatch, the body below gates the assignment
   * on `phase === "view"` so the projection handle only ever lands on
   * view-phase contexts.
   */
  readonly projection?: ProjectionQueryView;
};

type DispatchFrame = {
  readonly processor: Processor<unknown>;
  readonly phase: "adoption" | "garden" | "view";
  readonly runId: RunId;
  readonly declared: ReadonlyArray<Capability>;
  readonly granted: ReadonlyArray<Capability>;
  readonly startedAt: Date;
  readonly ledger?: LedgerDb;
};

type ExecutionContextBuildResult = {
  readonly ctx: ProcessorContext<unknown>;
  readonly costUsd: () => number;
};

export async function dispatchOneProcessor<TEnvelope>(
  opts: DispatchOneProcessorOptions<TEnvelope>,
): Promise<RunnerResult> {
  const frame = beginDispatch(opts);
  const policyResult = resolveDispatchPolicy(frame);
  if (!policyResult.ok) {
    return skipForPolicyDenial(frame, policyResult.error);
  }

  const quarantineKey = dispatchQuarantineKey(opts);
  const quarantineSkip = skipForQuarantine(frame, opts, quarantineKey);
  if (quarantineSkip !== null) return quarantineSkip;

  markDispatchRunning(frame);
  const executionInput = buildExecutionContext(opts, frame, policyResult.value);
  const execution = await executeProcessor({
    processorId: frame.processor.id,
    phase: frame.phase,
    runId: frame.runId,
    ctx: executionInput.ctx,
    policy: policyResult.value,
    run: frame.processor.run as (ctx: ProcessorContext<unknown>) => Promise<unknown>,
  });

  markDispatchTerminal(frame, execution, executionInput.costUsd());
  if (opts.executionState !== undefined && quarantineKey !== null) {
    updateExecutionStateAfterRun({
      state: opts.executionState,
      key: quarantineKey,
      execution,
    });
  }

  return runnerResultForExecution(frame, execution);
}

// ----- internals ------------------------------------------------------------

function beginDispatch<TEnvelope>(
  opts: DispatchOneProcessorOptions<TEnvelope>,
): DispatchFrame {
  const declared = opts.processor.capabilities;
  const granted = opts.resolveGrants(opts.processor.id);
  const extensionId = opts.extensionIdFor(opts.processor.id);
  const startedAt = new Date();
  const runId: RunId =
    opts.ledger !== undefined
      ? newRunId(startedAt)
      : (makeRunContext({
          extensionId,
          base: opts.proposal?.base ?? opts.inputCommit,
          sourceHead: opts.proposal?.head ?? opts.inputCommit,
        }).runId as RunId);

  if (opts.ledger !== undefined) {
    insertQueued(opts.ledger, {
      id: runId,
      proposalId: opts.proposal?.id ?? null,
      processorId: opts.processor.id,
      processorVersion: opts.processor.version,
      phase: opts.phase,
      inputCommit: opts.inputCommit,
      triggerKind: triggerKindOf(opts.matches),
      triggerPayload: triggerPayloadOf(opts.matches),
      startedAt,
    });
  }

  const frame = {
    processor: opts.processor,
    phase: opts.phase,
    runId,
    declared,
    granted,
    startedAt,
    ...(opts.ledger !== undefined ? { ledger: opts.ledger } : {}),
  };
  return Object.freeze(frame);
}

function resolveDispatchPolicy(frame: DispatchFrame): ReturnType<
  typeof resolveExecutionPolicy
> {
  return resolveExecutionPolicy({
    phase: frame.phase,
    request: frame.processor.execution,
    vaultCap: undefined,
  });
}

function skipForPolicyDenial(
  frame: DispatchFrame,
  policyError: ExecutionPolicyError,
): RunnerResult {
  return returnSkippedRun({
    frame,
    error: Object.freeze({
      code: policyError.code,
      message: policyError.message,
      retryable: false as const,
      phase: frame.phase,
      processorId: frame.processor.id,
      class: policyError.class,
    }),
    severity: frame.phase === "adoption" ? "block" : "error",
  });
}

function dispatchQuarantineKey<TEnvelope>(
  opts: DispatchOneProcessorOptions<TEnvelope>,
): ProcessorExecutionKey | null {
  if (
    opts.executionState === undefined ||
    !quarantineEligible(opts.phase, opts.matches)
  ) {
    return null;
  }
  return processorExecutionKey({
    phase: opts.phase,
    processorId: opts.processor.id,
    processorVersion: opts.processor.version,
    matches: opts.matches,
  });
}

function skipForQuarantine<TEnvelope>(
  frame: DispatchFrame,
  opts: DispatchOneProcessorOptions<TEnvelope>,
  key: ProcessorExecutionKey | null,
): RunnerResult | null {
  if (opts.executionState === undefined || key === null) return null;
  const quarantine = opts.executionState.quarantineFor(key);
  if (quarantine === null) return null;

  return returnSkippedRun({
    frame,
    error: Object.freeze({
      code: "processor.quarantined" as const,
      message:
        `Processor is quarantined for this trigger after ` +
        `${quarantine.consecutiveRetryableFailures} consecutive ` +
        `retryable failures: ${quarantine.reason}`,
      retryable: false as const,
      phase: frame.phase,
      processorId: frame.processor.id,
    }),
    severity: "error",
  });
}

function returnSkippedRun(opts: {
  readonly frame: DispatchFrame;
  readonly error: ProcessorSkippedExecutionError;
  readonly severity: "block" | "error";
}): RunnerResult {
  if (opts.frame.ledger !== undefined) {
    markSkipped(opts.frame.ledger, {
      id: opts.frame.runId,
      finishedAt: new Date(),
      error: JSON.stringify(opts.error),
    });
  }
  return Object.freeze({
    runId: opts.frame.runId,
    processorId: opts.frame.processor.id,
    executionStatus: "skipped",
    executionError: opts.error,
    declared: opts.frame.declared,
    granted: opts.frame.granted,
    effects: Object.freeze([
      diagnosticEffect({
        severity: opts.severity,
        code: opts.error.code,
        message: `${opts.frame.processor.id}: ${opts.error.message}`,
        sourceRefs: [],
      }),
    ]),
  });
}

function markDispatchRunning(frame: DispatchFrame): void {
  if (frame.ledger !== undefined) {
    markRunning(frame.ledger, frame.runId, frame.startedAt);
  }
}

function buildExecutionContext<TEnvelope>(
  opts: DispatchOneProcessorOptions<TEnvelope>,
  frame: DispatchFrame,
  policy: ResolvedExecutionPolicy,
): ExecutionContextBuildResult {
  const controller = new AbortController();
  let costUsd = 0;
  const modelInvoke = modelInvokeForProcessor({
    phase: frame.phase,
    processorId: frame.processor.id,
    declared: frame.declared,
    granted: frame.granted,
    policy,
    signal: controller.signal,
    ...(opts.modelProvider !== undefined ? { provider: opts.modelProvider } : {}),
    onCost: (cost) => {
      costUsd += cost;
    },
  });

  const ctxInput: ProcessorContextInput<TEnvelope> = {
    snapshot: scopeSnapshotForProcessor(opts.snapshot, frame),
    changedPaths: opts.changedPaths,
    proposal: opts.proposal,
    runId: frame.runId,
    input: opts.envelope,
    signal: controller.signal,
    ...(frame.phase === "view" && opts.projection !== undefined
      ? { projection: opts.projection }
      : {}),
    ...(modelInvoke !== undefined ? { modelInvoke } : {}),
  };

  return Object.freeze({
    ctx: makeProcessorContext(ctxInput) as ProcessorContext<unknown>,
    costUsd: () => costUsd,
  });
}

function scopeSnapshotForProcessor(
  snapshot: Snapshot,
  frame: DispatchFrame,
): Snapshot {
  return Object.freeze({
    commit: snapshot.commit,
    tree: snapshot.tree,
    readFile: async (path: string): Promise<string | null> => {
      const readable = readablePath(path, frame.declared, frame.granted);
      if (readable === null) return null;
      return snapshot.readFile(readable);
    },
    listMarkdownFiles: async (): Promise<ReadonlyArray<string>> => {
      const paths = await snapshot.listMarkdownFiles();
      return filterReadablePaths(paths, frame.declared, frame.granted);
    },
  });
}

function markDispatchTerminal(
  frame: DispatchFrame,
  execution: ProcessorExecutionResult,
  costUsd: number,
): void {
  if (frame.ledger === undefined) return;
  const finishedAt = new Date();
  if (execution.status === "succeeded") {
    markSucceeded(frame.ledger, {
      id: frame.runId,
      effectHashes: execution.effectHashes,
      costUsd: costUsdOrNull(costUsd),
      durationMs: execution.durationMs,
      outputCommit: null,
      finishedAt,
    });
  } else if (execution.status === "timed_out") {
    markTimedOut(frame.ledger, {
      id: frame.runId,
      error: execution.error,
      costUsd: costUsdOrNull(costUsd),
      durationMs: execution.durationMs,
      finishedAt,
    });
  } else if (execution.status === "cancelled") {
    markCancelled(frame.ledger, {
      id: frame.runId,
      error: execution.error,
      costUsd: costUsdOrNull(costUsd),
      durationMs: execution.durationMs,
      finishedAt,
    });
  } else {
    markFailed(frame.ledger, {
      id: frame.runId,
      error: execution.error,
      costUsd: costUsdOrNull(costUsd),
      durationMs: execution.durationMs,
      finishedAt,
    });
  }
}

function runnerResultForExecution(
  frame: DispatchFrame,
  execution: ProcessorExecutionResult,
): RunnerResult {
  const executionError =
    execution.status === "succeeded" ? undefined : execution.error;
  return Object.freeze({
    runId: frame.runId,
    processorId: frame.processor.id,
    executionStatus: execution.status,
    ...(executionError !== undefined ? { executionError } : {}),
    declared: frame.declared,
    granted: frame.granted,
    effects:
      execution.status === "succeeded"
        ? execution.effects
        : Object.freeze([execution.diagnostic]),
  });
}

/**
 * Extract the `trigger_kind` column value from the matched-triggers list.
 * The runtime guarantees `matches.length > 0` at the call site (only firing
 * processors enter the ledger lifecycle), so reading `matches[0]` is safe;
 * `noUncheckedIndexedAccess` requires the `=== undefined` guard for the
 * type narrowing.
 *
 * A processor whose triggers fire from multiple kinds in one iteration is
 * uncommon in v1 — most adoption-phase processors declare a single
 * `{ kind: "signal" }` or `{ kind: "path" }` trigger. The first-match
 * convention keeps the column scalar; the full `trigger_payload_json`
 * carries the per-trigger detail for forensics.
 */
function triggerKindOf(matches: ReadonlyArray<TriggerMatch>): TriggerKind {
  const first = matches[0];
  if (first === undefined) {
    // Defensive: the caller guards `matches.length === 0` before invoking
    // this helper. Reaching here is a programmer error — surface loudly.
    throw new Error("runtime: triggerKindOf called with empty matches");
  }
  return first.trigger.kind;
}

function quarantineEligible(
  phase: "adoption" | "garden" | "view",
  matches: ReadonlyArray<TriggerMatch>,
): boolean {
  if (phase === "garden") return true;
  if (phase !== "view") return false;
  return matches.some((m) => m.trigger.kind === "schedule");
}

function updateExecutionStateAfterRun(opts: {
  readonly state: ProcessorExecutionState;
  readonly key: ProcessorExecutionKey;
  readonly execution: Awaited<ReturnType<typeof executeProcessor>>;
}): void {
  if (opts.execution.status === "succeeded") {
    opts.state.recordSuccess(opts.key);
    return;
  }
  if (opts.execution.error.retryable) {
    opts.state.recordRetryableTerminalFailure(
      opts.key,
      `${opts.execution.error.code}: ${opts.execution.error.message}`,
    );
    return;
  }
  opts.state.recordNonRetryableTerminalFailure(opts.key);
}

function costUsdOrNull(costUsd: number): number | null {
  return costUsd > 0 ? costUsd : null;
}

/**
 * Capture the matched-trigger detail as the `trigger_payload_json` column
 * value (per-trigger kind + matched signal events). The full match list is
 * stored, not just the first match — a future audit surface can replay the
 * exact fan-in that caused the run.
 *
 * The matched events are the (signal, path) pairs that fired the trigger;
 * they're the input the processor saw, modulo the runtime's
 * `ProcessorContext` envelope construction.
 */
function triggerPayloadOf(
  matches: ReadonlyArray<TriggerMatch>,
): ReadonlyArray<{ readonly trigger: TriggerMatch["trigger"]; readonly matchedSignals: TriggerMatch["matchedSignals"] }> {
  return matches.map((m) => ({
    trigger: m.trigger,
    matchedSignals: m.matchedSignals,
  }));
}

/**
 * Walk the tree at `commit` and return every blob path ending in `.md`,
 * sorted lexicographically for determinism. Used to back the
 * `Snapshot.listMarkdownFiles` closure — adoption-phase processors that
 * resolve wikilink targets need the full markdown file set for the
 * candidate snapshot.
 *
 * Path strings are POSIX-joined (matches the convention in
 * `src/engine/compile-range.ts`'s walker). Non-blob entries (subtrees) are
 * recursed into; the recursion is bounded by the tree's natural depth.
 */
async function listMarkdownPathsInTree(
  vaultPath: string,
  commit: CommitOid,
): Promise<ReadonlyArray<string>> {
  const out: string[] = [];
  await walkTreeForMarkdown(vaultPath, commit, "", out);
  out.sort();
  return Object.freeze(out);
}

async function walkTreeForMarkdown(
  vaultPath: string,
  oid: string,
  prefix: string,
  out: string[],
): Promise<void> {
  const tree = await readTree({ path: vaultPath, oid });
  for (const entry of tree.tree) {
    const path = prefix === "" ? entry.path : posix.join(prefix, entry.path);
    if (entry.type === "tree") {
      await walkTreeForMarkdown(vaultPath, entry.oid, path, out);
    } else if (entry.type === "blob" && path.endsWith(".md")) {
      out.push(path);
    }
  }
}
