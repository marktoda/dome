// ProcessorRuntime: the adapter that satisfies the engine's adoption,
// garden, and view runner contracts by walking the loaded
// `ProcessorRegistry`, matching triggers, packaging a `ProcessorContext`
// via `makeProcessorContext`, invoking processors through the executor
// boundary, and collecting one `RunnerResult` per firing processor.
//
// See docs/wiki/specs/processors.md §"The three phases" + §"Triggers and
// signals" + §"Run ledger" for the operational contract this runtime
// implements, and docs/wiki/specs/adoption.md §"The fixed-point adoption
// loop" for the call site (`src/engine/core/adopt.ts`'s `runAdoptionProcessors`
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
//     (CommitOid), `../engine/core/runner-contract` (AdoptionPhaseRunner +
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
//     surfaces `readBlob` / `readTree` / `fileInfoAtCommit` for the Snapshot's read closures
//     (`readFile`, `listMarkdownFiles`, `getFileInfo`); the closures are lazy — invoked
//     only when an adoption-phase processor reads from `ctx.snapshot` —
//     so runtimes whose processors don't touch the snapshot incur no git
//     I/O. The ledger handle's SQLite I/O is owned by `src/ledger/`.

import { posix } from "node:path";

import { diagnosticEffect, type Effect } from "../core/effect";
import type {
  Capability,
  ExtensionConfig,
  InspectionScope,
  OperationalOutboxStatus,
  OperationalRunStatus,
  OperationalQueryView,
  Processor,
  ProcessorContext,
  ProjectionQueryView,
  Snapshot,
  SnapshotFileInfo,
  TreeOid,
} from "../core/processor";
import type { Proposal } from "../core/proposal";
import { commitOid, type CommitOid } from "../core/source-ref";
import type { PageTypeRegistry } from "../page-types";
import { fileInfoAtCommit, readBlob, readTree } from "../git";
import type {
  AdoptionPhaseRunner,
  GardenPhaseRunner,
  ProcessorSkippedExecutionError,
  RunnerResult,
  ViewPhaseRunner,
} from "../engine/core/runner-contract";
import type { SignalEvent } from "../engine/core/compile-range";
import type { LedgerDb } from "../ledger/db";
import { recordCapabilityUse } from "../ledger/capability-uses";
import {
  executeProcessor,
  type ProcessorExecutionResult,
  type ProcessorOutputPolicy,
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
  type ExecutionPolicyCap,
  type ResolvedExecutionPolicy,
} from "./execution-policy";
import {
  insertQueued,
  markRunning,
  markSkipped,
  markTerminal,
  newRunId,
  sumCostUsdByProcessorPrefix,
  type RunId,
  type TerminalMark,
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
  type ModelStepProvider,
} from "../engine/core/model-invoke";
import {
  filterReadablePaths,
  readablePath,
} from "../engine/core/path-capabilities";
import { scopeProjectionQueryView } from "./projection-scope";

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
 * The orchestrator at `src/engine/garden/garden.ts` constructs the envelope from
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
  readonly close: () => Promise<void>;
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
 * `buildRuntime` (today: `src/engine/host/vault-runtime.ts` or test harnesses)
 * wires the resolver against the live git boundary.
 */
export type BuildRuntimeOptions = {
  readonly registry: ProcessorRegistry;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly extensionConfigFor?: (extensionId: string) => ExtensionConfig;
  readonly resolveTree: (commit: CommitOid) => Promise<TreeOid>;
  /**
   * Optional run-ledger handle. When present, every dispatched processor
   * lands one row in `runs` per [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]]
   * §"Structural enforcement": `insertQueued` before policy resolution,
   * `markSkipped` for pre-run policy denial, `markRunning` before executor
   * invocation, and exactly one terminal mark (`succeeded`, `failed`,
   * `timed_out`, or `cancelled`) after executor completion.
   *
   * Optional for unit tests and lightweight fixtures. When absent, no ledger
   * writes occur and the runner-result
   * `runId` falls back to a `makeRunContext`-synthesized placeholder so
   * downstream `applyEffect` capability-use recording still has a slot
   * (the engine's adoption loop skips ledger writes if the ledger itself
   * is absent at its own seam).
   */
  readonly ledger?: LedgerDb;
  /**
   * Optional read-only projection query surface. When present, view-phase
   * and garden-phase processor invocations populate `ctx.projection` so
   * command-triggered views and adopted-state garden processors (e.g.
   * `dome.agent.brief` reading the open-question batch) can read facts,
   * diagnostics, and questions out of the projection store. Adoption-phase
   * invocations never receive the handle — the fixed-point loop reads state
   * via `ctx.snapshot` from the candidate tree and must not depend on
   * derived state.
   *
   * Optional because tests that exercise only the adoption / garden runners
   * (e.g., `tests/processors/runtime.test.ts`) don't need to wire a
   * projection view. The composed runtime built by
   * `src/engine/host/vault-runtime.ts` populates this against the open
   * `ProjectionDb`.
   */
  readonly projection?: ProjectionQueryView;
  readonly operational?: OperationalQueryView;
  readonly pageTypes?: PageTypeRegistry;
  readonly executionState?: ProcessorExecutionState;
  readonly executionCap?: ExecutionPolicyCap;
  readonly modelProvider?: ModelProvider;
  readonly modelStepProvider?: ModelStepProvider;
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
    extensionConfigFor,
    resolveTree,
    ledger,
    projection,
    operational,
    pageTypes,
    executionCap,
    modelProvider,
    modelStepProvider,
  } = opts;
  const executionState =
    opts.executionState ?? buildProcessorExecutionState();
  const lifecycle = makeRuntimeLifecycle();

  const adoptionRunner: AdoptionPhaseRunner = (input) =>
    lifecycle.track(runAdoption(input));
  const gardenRunner: GardenPhaseRunner = (input) =>
    lifecycle.track(runGarden(input));
  const viewRunner: ViewPhaseRunner = (input) =>
    lifecycle.track(runView(input));

  async function runAdoption(
    input: Parameters<AdoptionPhaseRunner>[0],
  ): Promise<ReadonlyArray<RunnerResult>> {
    if (lifecycle.isClosing()) {
      return Object.freeze([]);
    }
    const adoptionProcessors = registry.byPhase("adoption");
    if (adoptionProcessors.length === 0) {
      return Object.freeze([]);
    }

    const runnerSignal = combineAbortSignals(input.signal, lifecycle.signal);
    try {
      const snapshot = await makeSnapshot(
        input.vault.path,
        input.candidate,
        resolveTree,
      );

      const results: RunnerResult[] = [];
      for (const processor of adoptionProcessors) {
        if (runnerSignal.signal?.aborted === true) break;
        const readableSignals = readableSignalsForProcessor({
          processor,
          signals: input.signals,
          resolveGrants,
        });
        const matches = matchTriggers(processor.triggers, readableSignals);
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
          ...(extensionConfigFor !== undefined ? { extensionConfigFor } : {}),
          ledger,
          executionState,
          ...(executionCap !== undefined ? { executionCap } : {}),
          ...(runnerSignal.signal !== undefined
            ? { signal: runnerSignal.signal }
            : {}),
          ...(pageTypes !== undefined ? { pageTypes } : {}),
          ...(modelProvider !== undefined ? { modelProvider } : {}),
          ...(modelStepProvider !== undefined ? { modelStepProvider } : {}),
        });
        results.push(result);
      }

      return Object.freeze(results);
    } finally {
      runnerSignal.cleanup();
    }
  }

  async function runGarden(
    input: Parameters<GardenPhaseRunner>[0],
  ): Promise<ReadonlyArray<RunnerResult>> {
    if (lifecycle.isClosing()) {
      return Object.freeze([]);
    }
    const gardenProcessors = registry.byPhase("garden");
    if (gardenProcessors.length === 0) {
      return Object.freeze([]);
    }
    const runnerSignal = combineAbortSignals(input.signal, lifecycle.signal);
    try {
      // Garden's Snapshot is built against the **adopted** commit — the
      // new trusted state — not a candidate. Same closures, different
      // commit. Processors read from this snapshot via `ctx.snapshot`.
      const snapshot = await makeSnapshot(
        input.vault.path,
        input.adopted,
        resolveTree,
      );

      const results: RunnerResult[] = [];
      for (let i = 0; i < gardenProcessors.length; i += 1) {
        const processor = gardenProcessors[i]!;
        if (runnerSignal.signal?.aborted === true) {
          // EVERY_PROCESSOR_RUN_IS_LEDGERED: the garden pass for this
          // proposal never re-runs, so a silent break would make a mid-tick
          // shutdown indistinguishable from "never matched" for every
          // processor not yet dispatched (the 2026-06-10 ingest mystery).
          // Record a reasoned skip row per remaining matched processor.
          results.push(
            ...recordAbortedBeforeDispatch({
              processors: gardenProcessors.slice(i),
              phase: "garden",
              signals: input.signals,
              resolveGrants,
              proposalId: input.proposal?.id ?? null,
              inputCommit: input.adopted,
              ...(ledger !== undefined ? { ledger } : {}),
            }),
          );
          break;
        }
        const readableSignals = readableSignalsForProcessor({
          processor,
          signals: input.signals,
          resolveGrants,
        });
        const matches = matchTriggers(processor.triggers, readableSignals);
        if (matches.length === 0) continue;

        input.onProcessorStart?.({
          processorId: processor.id,
          ...(processor.execution?.class !== undefined
            ? { executionClass: processor.execution.class }
            : {}),
        });

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
          ...(input.now !== undefined ? { now: input.now() } : {}),
          resolveGrants,
          extensionIdFor,
          ...(extensionConfigFor !== undefined ? { extensionConfigFor } : {}),
          ledger,
          executionState,
          ...(executionCap !== undefined ? { executionCap } : {}),
          ...(runnerSignal.signal !== undefined
            ? { signal: runnerSignal.signal }
            : {}),
          ...(operational !== undefined ? { operational } : {}),
          ...(pageTypes !== undefined ? { pageTypes } : {}),
          ...(modelProvider !== undefined ? { modelProvider } : {}),
          ...(modelStepProvider !== undefined ? { modelStepProvider } : {}),
          // Garden processors run over ADOPTED state, so reading the
          // adopted-state projection (questions, facts, diagnostics) is
          // safe; the context builder scopes the view by the processor's
          // effective read grant. Adoption dispatch never passes this.
          ...(projection !== undefined ? { projection } : {}),
        });
        results.push(result);
      }

      return Object.freeze(results);
    } finally {
      runnerSignal.cleanup();
    }
  }

  async function runView(
    input: Parameters<ViewPhaseRunner>[0],
  ): Promise<RunnerResult | null> {
    if (lifecycle.isClosing()) {
      return null;
    }
    const viewProcessors = registry.byPhase("view");
    if (viewProcessors.length === 0) {
      return null;
    }

    // Find the view-phase processor whose triggers include
    // `{ kind: "command", name: input.commandName }`. Per
    // Registry validation rejects `duplicate-command-trigger`, so one
    // command name maps to at most one view-phase processor. `find`
    // (not `filter`) is correct here because runtime construction would
    // have failed before this dispatcher can run.
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
    const runnerSignal = combineAbortSignals(input.signal, lifecycle.signal);
    try {
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
        ...(extensionConfigFor !== undefined ? { extensionConfigFor } : {}),
        ledger,
        executionState,
        ...(executionCap !== undefined ? { executionCap } : {}),
        ...(runnerSignal.signal !== undefined
          ? { signal: runnerSignal.signal }
          : {}),
        ...(pageTypes !== undefined ? { pageTypes } : {}),
        ...(modelProvider !== undefined ? { modelProvider } : {}),
        ...(modelStepProvider !== undefined ? { modelStepProvider } : {}),
        // View-phase processors receive the projection query view so they
        // can read facts / diagnostics / questions out of the projection
        // store via `ctx.projection` (garden dispatch passes it too;
        // adoption never does — see DispatchOptions.projection).
        // Conditional spread keeps the call site exactOptionalPropertyTypes-
        // clean when no projection is wired (e.g., test harnesses that build
        // a runtime without projection).
        ...(projection !== undefined ? { projection } : {}),
        ...(operational !== undefined ? { operational } : {}),
      });
    } finally {
      runnerSignal.cleanup();
    }
  }

  return Object.freeze({
    adoptionRunner,
    gardenRunner,
    viewRunner,
    executionState,
    close: lifecycle.close,
  });
}

type RuntimeLifecycle = {
  readonly signal: AbortSignal;
  readonly isClosing: () => boolean;
  readonly close: () => Promise<void>;
  readonly track: <T>(promise: Promise<T>) => Promise<T>;
};

function makeRuntimeLifecycle(): RuntimeLifecycle {
  const controller = new AbortController();
  const active = new Set<Promise<unknown>>();
  let closing = false;

  return Object.freeze({
    signal: controller.signal,
    isClosing: () => closing,
    close: async () => {
      if (!closing) {
        closing = true;
        controller.abort();
      }
      await Promise.allSettled([...active]);
    },
    track: <T>(promise: Promise<T>): Promise<T> => {
      active.add(promise);
      return promise.finally(() => active.delete(promise));
    },
  });
}

type CombinedAbortSignal = {
  readonly signal?: AbortSignal;
  readonly cleanup: () => void;
};

function combineAbortSignals(
  primary: AbortSignal | undefined,
  runtime: AbortSignal,
): CombinedAbortSignal {
  if (primary === undefined) {
    return Object.freeze({ signal: runtime, cleanup: () => {} });
  }

  if (primary.aborted || runtime.aborted) {
    const controller = new AbortController();
    controller.abort();
    return Object.freeze({ signal: controller.signal, cleanup: () => {} });
  }

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  primary.addEventListener("abort", abort, { once: true });
  runtime.addEventListener("abort", abort, { once: true });

  return Object.freeze({
    signal: controller.signal,
    cleanup: () => {
      primary.removeEventListener("abort", abort);
      runtime.removeEventListener("abort", abort);
    },
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
  const readFileCache = new Map<string, Promise<string | null>>();
  const fileInfoCache = new Map<string, Promise<SnapshotFileInfo | null>>();
  let markdownFilesCache: Promise<ReadonlyArray<string>> | null = null;

  return Object.freeze({
    commit,
    tree,
    readFile: (path: string) => {
      let cached = readFileCache.get(path);
      if (cached === undefined) {
        cached = readBlob({ path: vaultPath, commit, filepath: path });
        readFileCache.set(path, cached);
      }
      return cached;
    },
    listMarkdownFiles: () => {
      markdownFilesCache ??= listMarkdownPathsInTree(vaultPath, commit);
      return markdownFilesCache;
    },
    getFileInfo: async (path: string) => {
      let cached = fileInfoCache.get(path);
      if (cached === undefined) {
        cached = fileInfoAtCommit({ path: vaultPath, commit, filepath: path })
          .then((info) =>
            info === null
              ? null
              : {
                  lastChangedCommit: commitOid(info.lastChangedCommit),
                  lastChangedAt: info.lastChangedAt,
                  lastHumanChangedAt: info.lastHumanChangedAt,
                }
          );
        fileInfoCache.set(path, cached);
      }
      return cached;
    },
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
  readonly now?: Date;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly extensionConfigFor?: (extensionId: string) => ExtensionConfig;
  readonly ledger: LedgerDb | undefined;
  readonly executionCap?: ExecutionPolicyCap;
  readonly signal?: AbortSignal;
  readonly executionState?: ProcessorExecutionState;
  readonly modelProvider?: ModelProvider;
  readonly modelStepProvider?: ModelStepProvider;
  readonly pageTypes?: PageTypeRegistry;
  readonly operational?: OperationalQueryView;
  /**
   * The projection query view to thread onto `ctx.projection`. The view-
   * and garden-phase callers pass this (both run over adopted state);
   * adoption callers leave it undefined so adoption processors see
   * `ctx.projection === undefined` (the fixed-point loop reads state from
   * `ctx.snapshot`, never from derived state).
   *
   * Defensively, even when a caller mistakenly passes a projection on an
   * adoption dispatch, the body below gates the assignment on
   * `phase === "view" || phase === "garden"` so the projection handle
   * never lands on an adoption context.
   */
  readonly projection?: ProjectionQueryView;
};

type DispatchFrame = {
  readonly processor: Processor<unknown>;
  readonly phase: "adoption" | "garden" | "view";
  readonly runId: RunId;
  readonly extensionId: string;
  readonly declared: ReadonlyArray<Capability>;
  readonly granted: ReadonlyArray<Capability>;
  readonly contextChangedPaths: ReadonlyArray<string>;
  readonly inspectedPaths: ReadonlyArray<string>;
  readonly startedAt: Date;
  readonly executionCap?: ExecutionPolicyCap;
  readonly ledger?: LedgerDb;
};

type ExecutionContextBuildResult = {
  readonly makeContext: (signal: AbortSignal) => ProcessorContext<unknown>;
  readonly costUsd: () => number;
};

export async function dispatchOneProcessor<TEnvelope>(
  opts: DispatchOneProcessorOptions<TEnvelope>,
): Promise<RunnerResult> {
  const frame = await beginDispatch(opts);
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
    makeContext: executionInput.makeContext,
    policy: policyResult.value,
    outputPolicy: outputPolicyForFrame(frame),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
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

async function beginDispatch<TEnvelope>(
  opts: DispatchOneProcessorOptions<TEnvelope>,
): Promise<DispatchFrame> {
  const declared = opts.processor.capabilities;
  const granted = opts.resolveGrants(opts.processor.id);
  const extensionId = opts.extensionIdFor(opts.processor.id);
  const startedAt = opts.now ?? new Date();
  const contextChangedPaths = Object.freeze(
    filterReadablePaths(opts.changedPaths, declared, granted),
  );
  const runId: RunId =
    opts.ledger !== undefined
      ? newRunId(startedAt)
      : (makeRunContext({
          extensionId,
          base: opts.proposal?.base ?? opts.inputCommit,
          sourceHead: opts.proposal?.head ?? opts.inputCommit,
        }).runId as RunId);

  // Ledger the queued row BEFORE any async work. `resolveInspectionPaths`
  // can do a full git tree walk (inspection: all-readable-markdown); a git
  // error there used to leave a trigger-matched invocation with NO run row
  // — the one outcome EVERY_PROCESSOR_RUN_IS_LEDGERED forbids.
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

  let inspectedPaths: ReadonlyArray<string>;
  try {
    inspectedPaths = await resolveInspectionPaths({
      scope: opts.processor.inspection,
      snapshot: opts.snapshot,
      changedPaths: contextChangedPaths,
      declared,
      granted,
    });
  } catch (e) {
    // The processor was never invoked: record a reasoned skip so the row
    // reaches a terminal state, then rethrow to preserve the caller's
    // failure semantics.
    if (opts.ledger !== undefined) {
      markSkipped(opts.ledger, {
        id: runId,
        finishedAt: opts.now ?? new Date(),
        error: JSON.stringify({
          code: "dispatch.inspection-paths-failed",
          message: e instanceof Error ? e.message : String(e),
          phase: opts.phase,
          processorId: opts.processor.id,
        }),
      });
    }
    throw e;
  }

  const frame = {
    processor: opts.processor,
    phase: opts.phase,
    runId,
    extensionId,
    declared,
    granted,
    contextChangedPaths,
    inspectedPaths,
    startedAt,
    ...(opts.executionCap !== undefined
      ? { executionCap: opts.executionCap }
      : {}),
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
    vaultCap: frame.executionCap,
  });
}

function outputPolicyForFrame(frame: DispatchFrame): ProcessorOutputPolicy {
  return Object.freeze({
    requireSourceBackedPatchEffects: hasEffectiveNonAdoptionCapability(
      frame,
      "model.invoke",
    ),
  });
}

function hasEffectiveNonAdoptionCapability(
  frame: DispatchFrame,
  kind: Capability["kind"],
): boolean {
  if (frame.phase === "adoption") return false;
  return (
    frame.declared.some((capability) => capability.kind === kind) &&
    frame.granted.some((capability) => capability.kind === kind)
  );
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
    inspectedPaths: opts.frame.inspectedPaths,
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

/**
 * Ledger a reasoned skip for every trigger-matched processor a phase runner
 * abandoned when its signal aborted mid-pass (engine shutdown / `dome
 * restart`). Unlike quarantine/policy skips this emits NO diagnostic
 * effect: a routine restart mid-garden must not mint attention-raising
 * diagnostics — the skip rows are the audit trail.
 */
function recordAbortedBeforeDispatch(opts: {
  readonly processors: ReadonlyArray<Processor<unknown>>;
  readonly phase: "adoption" | "garden";
  readonly signals: ReadonlyArray<SignalEvent>;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
  readonly proposalId: string | null;
  readonly inputCommit: CommitOid;
  readonly ledger?: LedgerDb;
}): ReadonlyArray<RunnerResult> {
  const results: RunnerResult[] = [];
  for (const processor of opts.processors) {
    const readableSignals = readableSignalsForProcessor({
      processor,
      signals: opts.signals,
      resolveGrants: opts.resolveGrants,
    });
    const matches = matchTriggers(processor.triggers, readableSignals);
    if (matches.length === 0) continue;

    const startedAt = new Date();
    const runId = newRunId(startedAt);
    const error = Object.freeze({
      code: "processor.aborted-before-dispatch" as const,
      message:
        "phase runner aborted before this trigger-matched processor was " +
        "dispatched (engine shutdown or restart mid-tick); this proposal's " +
        "pass will not re-run.",
      retryable: false as const,
      phase: opts.phase,
      processorId: processor.id,
    });
    if (opts.ledger !== undefined) {
      insertQueued(opts.ledger, {
        id: runId,
        proposalId: opts.proposalId,
        processorId: processor.id,
        processorVersion: processor.version,
        phase: opts.phase,
        inputCommit: opts.inputCommit,
        triggerKind: triggerKindOf(matches),
        triggerPayload: triggerPayloadOf(matches),
        startedAt,
      });
      markSkipped(opts.ledger, {
        id: runId,
        finishedAt: startedAt,
        error: JSON.stringify(error),
      });
    }
    results.push(
      Object.freeze({
        runId,
        processorId: processor.id,
        executionStatus: "skipped" as const,
        executionError: error,
        declared: processor.capabilities,
        granted: opts.resolveGrants(processor.id),
        inspectedPaths: Object.freeze([]) as ReadonlyArray<string>,
        effects: Object.freeze([]) as ReadonlyArray<Effect>,
      }),
    );
  }
  return Object.freeze(results);
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
  let costUsd = 0;

  return Object.freeze({
    makeContext: (signal: AbortSignal): ProcessorContext<unknown> => {
      const modelInvoke = modelInvokeForProcessor({
        phase: frame.phase,
        processorId: frame.processor.id,
        declared: frame.declared,
        granted: frame.granted,
        policy,
        signal,
        ...(opts.modelProvider !== undefined
          ? { provider: opts.modelProvider }
          : {}),
        ...(opts.modelStepProvider !== undefined
          ? { stepProvider: opts.modelStepProvider }
          : {}),
        onCost: (cost) => {
          costUsd += cost;
        },
        onCapabilityUse: (use) => {
          if (frame.ledger === undefined) return;
          recordCapabilityUse(frame.ledger, {
            runId: frame.runId,
            capability: use.capability,
            resource: use.resource,
            outcome: use.outcome,
            recordedAt: new Date(),
          });
        },
        spentUsdTodayByProcessor: () =>
          modelSpendForToday({
            ledger: frame.ledger,
            processorIdPrefix: frame.processor.id,
            currentRunCostUsd: costUsd,
            now: frame.startedAt,
          }),
        spentUsdTodayByExtension: () =>
          modelSpendForToday({
            ledger: frame.ledger,
            processorIdPrefix: frame.extensionId,
            currentRunCostUsd: costUsd,
            now: frame.startedAt,
          }),
      });

      const ctxInput: ProcessorContextInput<TEnvelope> = {
        snapshot: scopeSnapshotForProcessor(opts.snapshot, frame),
        changedPaths: frame.contextChangedPaths,
        proposal: opts.proposal,
        runId: frame.runId,
        input: scopeEnvelopeForProcessor(opts.envelope, frame),
        now: frame.startedAt,
        signal,
        canSourceRefPath: (path) =>
          readablePath(path, frame.declared, frame.granted) !== null,
        ...(opts.extensionConfigFor !== undefined
          ? { extensionConfig: opts.extensionConfigFor(frame.extensionId) }
          : {}),
        ...((frame.phase === "view" || frame.phase === "garden") &&
        opts.projection !== undefined
          ? {
              projection: scopeProjectionQueryView(
                opts.projection,
                (path) =>
                  readablePath(path, frame.declared, frame.granted) !== null,
              ),
            }
          : {}),
        ...operationalContextField(frame, opts.operational),
        ...(opts.pageTypes !== undefined ? { pageTypes: opts.pageTypes } : {}),
        ...(modelInvoke !== undefined ? { modelInvoke } : {}),
      };

      return makeProcessorContext(ctxInput) as ProcessorContext<unknown>;
    },
    costUsd: () => costUsd,
  });
}

async function resolveInspectionPaths(opts: {
  readonly scope: InspectionScope | undefined;
  readonly snapshot: Snapshot;
  readonly changedPaths: ReadonlyArray<string>;
  readonly declared: ReadonlyArray<Capability>;
  readonly granted: ReadonlyArray<Capability>;
}): Promise<ReadonlyArray<string>> {
  switch (opts.scope?.kind ?? "changed-paths") {
    case "changed-paths":
      return opts.changedPaths;
    case "all-readable-markdown": {
      const paths = await opts.snapshot.listMarkdownFiles();
      return Object.freeze(filterReadablePaths(paths, opts.declared, opts.granted));
    }
  }
}

function operationalContextField(
  frame: DispatchFrame,
  operational: OperationalQueryView | undefined,
): { readonly operational?: OperationalQueryView } {
  if (frame.phase === "adoption" || operational === undefined) return {};
  const allowedStatuses = effectiveOutboxReadStatuses(
    frame.declared,
    frame.granted,
  );
  const canReadQuarantine = effectiveQuarantineRead(
    frame.declared,
    frame.granted,
  );
  const allowedRunStatuses = effectiveRunReadStatuses(
    frame.declared,
    frame.granted,
  );
  if (
    allowedStatuses === null &&
    !canReadQuarantine &&
    allowedRunStatuses === null
  ) {
    return {};
  }
  return {
    operational: Object.freeze({
      outbox: (filter) => {
        if (allowedStatuses === null) return Object.freeze([]);
        if (
          filter?.status !== undefined &&
          !allowedStatuses.has(filter.status)
        ) {
          return Object.freeze([]);
        }
        return Object.freeze(
          operational
            .outbox(filter)
            .filter((row) => allowedStatuses.has(row.status)),
        );
      },
      quarantines: () =>
        canReadQuarantine
          ? operational.quarantines()
          : Object.freeze([]),
      orphanRuns: (filter) => {
        if (
          allowedRunStatuses === null ||
          !allowedRunStatuses.has("running")
        ) {
          return Object.freeze([]);
        }
        return operational.orphanRuns(filter);
      },
    }),
  };
}

function effectiveOutboxReadStatuses(
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): ReadonlySet<OperationalOutboxStatus> | null {
  const declaredCap = declared.find((cap) => cap.kind === "outbox.read");
  const grantedCap = granted.find((cap) => cap.kind === "outbox.read");
  if (declaredCap === undefined || grantedCap === undefined) return null;

  const declaredStatuses = outboxReadStatuses(declaredCap.statuses);
  const grantedStatuses = outboxReadStatuses(grantedCap.statuses);
  const effective = [...declaredStatuses].filter((status) =>
    grantedStatuses.has(status),
  );
  return effective.length === 0 ? null : new Set(effective);
}

const ALL_OUTBOX_STATUSES: ReadonlySet<OperationalOutboxStatus> = new Set([
  "pending",
  "sent",
  "failed",
  "abandoned",
]);

function outboxReadStatuses(
  statuses: ReadonlyArray<OperationalOutboxStatus> | undefined,
): ReadonlySet<OperationalOutboxStatus> {
  return statuses === undefined ? ALL_OUTBOX_STATUSES : new Set(statuses);
}

function effectiveQuarantineRead(
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): boolean {
  return (
    declared.some((cap) => cap.kind === "quarantine.read") &&
    granted.some((cap) => cap.kind === "quarantine.read")
  );
}

function effectiveRunReadStatuses(
  declared: ReadonlyArray<Capability>,
  granted: ReadonlyArray<Capability>,
): ReadonlySet<OperationalRunStatus> | null {
  const declaredCap = declared.find((cap) => cap.kind === "run.read");
  const grantedCap = granted.find((cap) => cap.kind === "run.read");
  if (declaredCap === undefined || grantedCap === undefined) return null;

  const declaredStatuses = runReadStatuses(declaredCap.statuses);
  const grantedStatuses = runReadStatuses(grantedCap.statuses);
  const effective = [...declaredStatuses].filter((status) =>
    grantedStatuses.has(status),
  );
  return effective.length === 0 ? null : new Set(effective);
}

const ALL_RUN_STATUSES: ReadonlySet<OperationalRunStatus> = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "timed_out",
  "cancelled",
]);

function runReadStatuses(
  statuses: ReadonlyArray<OperationalRunStatus> | undefined,
): ReadonlySet<OperationalRunStatus> {
  return statuses === undefined ? ALL_RUN_STATUSES : new Set(statuses);
}

function readableSignalsForProcessor(opts: {
  readonly processor: Processor<unknown>;
  readonly signals: ReadonlyArray<SignalEvent>;
  readonly resolveGrants: (processorId: string) => ReadonlyArray<Capability>;
}): ReadonlyArray<SignalEvent> {
  const granted = opts.resolveGrants(opts.processor.id);
  return Object.freeze(
    opts.signals.filter(
      (event) =>
        readablePath(event.path, opts.processor.capabilities, granted) !== null,
    ),
  );
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
    getFileInfo: async (path: string) => {
      const readable = readablePath(path, frame.declared, frame.granted);
      if (readable === null) return null;
      return snapshot.getFileInfo(readable);
    },
  });
}

function scopeEnvelopeForProcessor<TEnvelope>(
  envelope: TEnvelope,
  frame: DispatchFrame,
): TEnvelope {
  if (!hasMatchedTriggers(envelope)) return envelope;
  return Object.freeze({
    ...envelope,
    matchedTriggers: scopeTriggerMatchesForProcessor(
      envelope.matchedTriggers,
      frame,
    ),
  }) as TEnvelope;
}

function hasMatchedTriggers(
  envelope: unknown,
): envelope is { readonly matchedTriggers: ReadonlyArray<TriggerMatch> } {
  return (
    typeof envelope === "object" &&
    envelope !== null &&
    Array.isArray(
      (envelope as { readonly matchedTriggers?: unknown }).matchedTriggers,
    )
  );
}

function scopeTriggerMatchesForProcessor(
  matches: ReadonlyArray<TriggerMatch>,
  frame: DispatchFrame,
): ReadonlyArray<TriggerMatch> {
  return Object.freeze(
    matches.map((match) =>
      Object.freeze({
        trigger: match.trigger,
        matchedSignals: Object.freeze(
          match.matchedSignals.filter(
            (event) =>
              readablePath(event.path, frame.declared, frame.granted) !== null,
          ),
        ),
      }),
    ),
  );
}

function toTerminalMark(
  execution: ProcessorExecutionResult,
  costUsd: number | null,
): TerminalMark {
  switch (execution.status) {
    case "succeeded":
      return {
        status: "succeeded",
        effectHashes: execution.effectHashes,
        costUsd,
        durationMs: execution.durationMs,
        outputCommit: null,
      };
    case "timed_out":
      return {
        status: "timed_out",
        error: execution.error,
        costUsd,
        durationMs: execution.durationMs,
      };
    case "cancelled":
      return {
        status: "cancelled",
        error: execution.error,
        costUsd,
        durationMs: execution.durationMs,
      };
    case "failed":
      return {
        status: "failed",
        error: execution.error,
        costUsd,
        durationMs: execution.durationMs,
      };
  }
}

function markDispatchTerminal(
  frame: DispatchFrame,
  execution: ProcessorExecutionResult,
  costUsd: number,
): void {
  if (frame.ledger === undefined) return;
  const id = frame.runId;
  const finishedAt = new Date();
  const resolvedCostUsd = costUsdOrNull(costUsd);
  markTerminal(frame.ledger, {
    ...toTerminalMark(execution, resolvedCostUsd),
    id,
    finishedAt,
  });
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
    inspectedPaths: frame.inspectedPaths,
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

function modelSpendForToday(opts: {
  readonly ledger: LedgerDb | undefined;
  /** Full processor id for per-processor spend; extension id for the pool. */
  readonly processorIdPrefix: string;
  readonly currentRunCostUsd: number;
  readonly now: Date;
}): number {
  const persisted = opts.ledger === undefined
    ? 0
    : sumCostUsdByProcessorPrefix(opts.ledger, {
        processorIdPrefix: opts.processorIdPrefix,
        sinceIso: startOfLocalDay(opts.now).toISOString(),
      });
  return persisted + opts.currentRunCostUsd;
}

function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
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
 * `src/engine/core/compile-range.ts`'s walker). Non-blob entries (subtrees) are
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
