// engine/compiler-host: runtime host operations over an open VaultRuntime.
//
// CLI commands, the harness, and future non-CLI surfaces share the same
// drift/adoption path:
//
//   1. Compare working-tree HEAD to `refs/dome/adopted/<branch>`.
//   2. If drift is present, construct a `manual`-source Proposal and run
//      `adopt()` against the open `VaultRuntime`.
//
// `dome resolve` / `dome answer` also use this module for the same runtime-host
// wiring: frame-aware SQLite sinks, adopted-ref resolution, and garden
// sub-Proposal adoption. Keeping those operations together prevents each CLI
// verb from hand-rolling a slightly different engine host.
//
// Refactoring invariants:
//
//   - **Behavior preservation.** The daemon must continue to exhibit the
//     same per-tick semantics it had pre-extraction: detect drift,
//     synthesize the (HEAD, HEAD) empty-diff init when the adopted ref is
//     null, build the Proposal, run adopt, print a one-line summary.
//   - **Single host boundary.** Runtime-backed commands use the same sinks
//     (`buildSqliteSinks` against the runtime's open DBs), patch applier,
//     ledger, and sub-Proposal recursion.
//
// House-style notes (matches src/engine/vault-runtime.ts):
//   - `type X = { ... }` aliases, every field `readonly`.
//   - Not re-exported from `src/index.ts`; this is engine host machinery,
//     not SDK application surface.
//   - The host wires view capture explicitly; protocol-specific command
//     runners use their own capture sinks when they need to return views.

import { commitOid, type CommitOid } from "../core/source-ref";
import { makeManualProposal, type AdoptionResult } from "../core/proposal";
import { adopt, type AdoptEvent } from "./adopt";
import { applyPatchToCandidate } from "./apply-patch";
import { compileRange } from "./compile-range";
import {
  rebuildProjection,
  type ProjectionRebuildResult,
} from "./projection-rebuild";
import {
  runGardenPhase,
  type AdoptSubProposalFn,
  type GardenPhaseResult,
} from "./garden";
import type { GardenProcessorStart } from "./runner-contract";
import {
  runOperationalWork,
  type OperationalWorkResult,
} from "./operational-work";
import {
  runAnswerHandlers,
  type AnswerHandlerResult,
} from "./answers";
import {
  withCompilerHostBranchLock,
  type CompilerHostLockBusy,
} from "./compiler-host-lock";
import {
  makeResolveTree,
  type VaultRuntime,
} from "./vault-runtime";
import {
  markProjectionBuilt,
  projectionCacheKeysChanged,
  projectionRequiresRebuild,
} from "../projections/db";
import { buildSqliteSinks } from "../projections/sinks";
import type { QuestionRecord } from "../projections/questions";
import { getAdoptedRef, getCurrentBranch } from "../adopted-ref";
import { currentSha, isAncestor } from "../git";
import { replayFinalizeJournal } from "./finalize-journal";
import type { ApplyEffectSinks } from "./apply-effect";
import { failRunIfCurrent } from "../ledger/runs";
import { buildOperationalQueryView } from "./operational-query-view";
import { withProjectionWriteLock } from "./projection-lock";

// These files affect projection rows for pages that may not appear in the
// changed-path set, so adoption treats them as full projection invalidators.
const PROJECTION_GLOBAL_CONFIG_PATHS: ReadonlySet<string> = new Set([
  ".dome/page-types.yaml",
]);

// ----- Public types ---------------------------------------------------------

/**
 * The (base, head, branch) triple that names a single drift range. The
 * host's poll body builds this on every tick that detects drift; `dome
 * sync` builds it exactly once. Both pass it to `runOneAdoption`.
 *
 * `base === head` is a valid value — it represents the "empty-diff init"
 * case where the adopted ref is uninitialized and the first adoption
 * cycle runs an empty range against HEAD to advance the ref from `null`
 * to HEAD without engine writes.
 */
export type DriftInfo = {
  readonly base: CommitOid;
  readonly head: CommitOid;
  readonly branch: string;
};

/**
 * The discriminated outcome of `detectDrift`. Five variants:
 *
 *   - `drift`         — HEAD differs from the adopted ref (or the adopted
 *                       ref is uninitialized and the empty-diff init is
 *                       pending). Caller passes `info` to `runOneAdoption`.
 *   - `in-sync`       — adopted ref is initialized and equals HEAD; no
 *                       work to do.
 *   - `diverged`      — adopted is initialized but is not an ancestor of
 *                       HEAD; adoption refuses before constructing a
 *                       Proposal so engine branch writes cannot compound
 *                       a rewritten history.
 *   - `detached-head` — `.git/HEAD` is a raw OID, not a symbolic ref;
 *                       the adopted-ref substrate requires a branch.
 *   - `no-commits`    — repo exists but has zero commits yet (HEAD is
 *                       null); nothing to adopt.
 */
export type DriftResult =
  | { readonly kind: "drift"; readonly info: DriftInfo }
  | {
      readonly kind: "in-sync";
      readonly head: CommitOid;
      readonly branch: string;
    }
  | {
      readonly kind: "diverged";
      readonly branch: string;
      readonly adopted: CommitOid;
      readonly head: CommitOid;
    }
  | { readonly kind: "detached-head" }
  | { readonly kind: "no-commits" };

export type CompilerHostAdoptionCycleResult = {
  /** Primary user-drift adoption result. Garden/operational sub-Proposals may advance refs after this. */
  readonly adoption: AdoptionResult;
  readonly garden: GardenPhaseResult | null;
  readonly operational: OperationalWorkResult | null;
  /** Latest adopted ref after garden and operational sub-Proposals have had a chance to run. */
  readonly finalAdoptedRef: CommitOid;
  readonly projectionRebuild: ProjectionRebuildResult | null;
};

export type CompilerHostTickResult =
  | { readonly kind: "detached-head" }
  | { readonly kind: "no-commits" }
  | {
      readonly kind: "diverged";
      readonly branch: string;
      readonly adopted: CommitOid;
      readonly head: CommitOid;
    }
  | CompilerHostLockBusy
  | {
      readonly kind: "in-sync";
      readonly branch: string;
      readonly head: CommitOid;
      readonly operational: OperationalWorkResult | null;
      readonly finalAdoptedRef: CommitOid;
    }
  | {
      readonly kind: "adopted" | "blocked";
      readonly branch: string;
      readonly drift: DriftInfo;
      readonly adoption: AdoptionResult;
      readonly garden: GardenPhaseResult | null;
      readonly operational: OperationalWorkResult | null;
      readonly finalAdoptedRef: CommitOid;
      readonly projectionRebuild: ProjectionRebuildResult | null;
    };

export type AdoptedCursor = {
  current: CommitOid;
};

type CompilerHostTickCommonOptions = {
  readonly runtime: VaultRuntime;
  readonly now?: () => Date;
  readonly runOperationalWhenInSync?: boolean;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: AdoptEvent) => void;
  readonly onGardenProcessorStart?: (info: GardenProcessorStart) => void;
};

// ----- detectDrift ----------------------------------------------------------

/**
 * Inspect the vault's working-tree HEAD against
 * `refs/dome/adopted/<branch>`. Returns the discriminated outcome the
 * caller dispatches on. Never throws on expected git states: detached
 * HEAD, no commits, and uninitialized adopted ref are all returned as
 * structured results.
 *
 * Uninitialized adopted ref → `drift` with `base === head === HEAD`,
 * so the adoption loop runs an empty-diff iteration. `adopt()` converges
 * on iter 1 with no engine writes, then advances the adopted ref from
 * `null` → HEAD via `setAdoptedRef`'s initialization path. The next call
 * sees a now-initialized ref equal to HEAD and returns `in-sync`.
 */
export async function detectDrift(vaultPath: string): Promise<DriftResult> {
  const branch = await getCurrentBranch(vaultPath);
  if (branch === null) return { kind: "detached-head" };

  const head = await currentSha(vaultPath);
  if (head === null) return { kind: "no-commits" };

  const adopted = await getAdoptedRef(vaultPath, branch);

  if (adopted === null) {
    // Uninitialized adopted ref. Run the empty-diff init so subsequent
    // calls have a base to diff against.
    return {
      kind: "drift",
      info: {
        base: commitOid(head),
        head: commitOid(head),
        branch,
      },
    };
  }
  if (adopted === head) {
    return { kind: "in-sync", head: commitOid(head), branch };
  }
  const fastForward = await isAncestor({
    path: vaultPath,
    ancestor: adopted,
    descendant: head,
  });
  if (!fastForward) {
    return {
      kind: "diverged",
      branch,
      adopted: commitOid(adopted),
      head: commitOid(head),
    };
  }
  return {
    kind: "drift",
    info: {
      base: commitOid(adopted),
      head: commitOid(head),
      branch,
    },
  };
}

export type { AdoptEvent };

/**
 * Run one compiler-host tick: detect/refuse unworkable git states, adopt
 * branch drift when present, and optionally drain operational work when the
 * branch is already in sync. This is the shared semantic boundary for
 * `dome sync`, `dome serve`, and the harness; callers decide only when to
 * invoke it and how to render the returned result.
 */
export async function runCompilerHostTick(opts: CompilerHostTickCommonOptions & {
  readonly drift?: DriftResult;
}): Promise<CompilerHostTickResult> {
  const observedDrift = opts.drift ?? await detectDrift(opts.runtime.path);

  return runCompilerHostTickForObservedDrift({
    ...commonTickOptions(opts),
    observedDrift,
    relockAttempts: 0,
  });
}

async function runCompilerHostTickForObservedDrift(
  opts: CompilerHostTickCommonOptions & {
    readonly observedDrift: DriftResult;
    readonly relockAttempts: number;
  },
): Promise<CompilerHostTickResult> {
  if (
    opts.observedDrift.kind === "detached-head" ||
    opts.observedDrift.kind === "no-commits" ||
    opts.observedDrift.kind === "diverged"
  ) {
    return Object.freeze({ ...opts.observedDrift });
  }

  const branch = driftBranch(opts.observedDrift);
  const locked = await withCompilerHostBranchLock(
    {
      vaultPath: opts.runtime.path,
      branch,
      command: "compiler-host-tick",
    },
    async () => {
      // Re-read inside the branch lock. A caller may have observed HEAD
      // before another commit landed; the locked tick must process the
      // current branch state, not the stale observation.
      const drift = await detectDrift(opts.runtime.path);
      if (
        drift.kind !== "detached-head" &&
        drift.kind !== "no-commits" &&
        drift.kind !== "diverged"
      ) {
        const freshBranch = driftBranch(drift);
        if (freshBranch !== branch && opts.relockAttempts < 1) {
          return Object.freeze({
            kind: "relock" as const,
            drift,
          });
        }
      }
      return runCompilerHostTickUnlocked({
        ...commonTickOptions(opts),
        drift,
      });
    },
  );
  if (locked.kind === "busy") return locked;
  if (locked.value.kind === "relock") {
    return runCompilerHostTickForObservedDrift({
      ...commonTickOptions(opts),
      observedDrift: locked.value.drift,
      relockAttempts: opts.relockAttempts + 1,
    });
  }
  return locked.value;
}

async function runCompilerHostTickUnlocked(opts: CompilerHostTickCommonOptions & {
  readonly drift: DriftResult;
}): Promise<CompilerHostTickResult> {
  const now = opts.now ?? ((): Date => new Date());
  const { drift } = opts;

  if (
    drift.kind === "detached-head" ||
    drift.kind === "no-commits" ||
    drift.kind === "diverged"
  ) {
    return Object.freeze({ ...drift });
  }

  // Repair any crash-interrupted adoption finalization before doing new
  // work under this branch lock. A surviving finalize-intent journal means
  // a prior process died between the branch advance and the working-tree
  // materialization (or mid-rollback); replay re-materializes affected
  // paths against whichever side the branch ref settled on, preserving any
  // human edits that arrived after the crash.
  await replayFinalizeJournal(opts.runtime.path);

  if (drift.kind === "in-sync") {
    let operational: OperationalWorkResult | null = null;
    if (opts.runOperationalWhenInSync !== false) {
      operational = await runOperationalWorkForAdoptedUnlocked({
        runtime: opts.runtime,
        adopted: drift.head,
        branch: drift.branch,
        now,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
    }
    return Object.freeze({
      kind: "in-sync" as const,
      branch: drift.branch,
      head: drift.head,
      operational,
      finalAdoptedRef: await latestAdoptedOr(
        opts.runtime.path,
        drift.branch,
        drift.head,
      ),
    });
  }

  const cycle = await runAdoptionCycle({
    runtime: opts.runtime,
    drift: drift.info,
    now,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
    ...(opts.onGardenProcessorStart !== undefined
      ? { onGardenProcessorStart: opts.onGardenProcessorStart }
      : {}),
  });

  const kind = cycle.adoption.adopted ? "adopted" as const : "blocked" as const;
  return Object.freeze({
    kind,
    branch: drift.info.branch,
    drift: drift.info,
    adoption: cycle.adoption,
    garden: cycle.garden,
    operational: cycle.operational,
    finalAdoptedRef: cycle.finalAdoptedRef,
    projectionRebuild: cycle.projectionRebuild,
  });
}

function driftBranch(
  drift: Extract<
    DriftResult,
    { readonly kind: "drift" | "in-sync" | "diverged" }
  >,
): string {
  if (drift.kind === "drift") return drift.info.branch;
  return drift.branch;
}

function commonTickOptions(
  opts: CompilerHostTickCommonOptions,
): CompilerHostTickCommonOptions {
  return {
    runtime: opts.runtime,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.runOperationalWhenInSync !== undefined
      ? { runOperationalWhenInSync: opts.runOperationalWhenInSync }
      : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
    ...(opts.onGardenProcessorStart !== undefined
      ? { onGardenProcessorStart: opts.onGardenProcessorStart }
      : {}),
  };
}

// ----- runOneAdoption -------------------------------------------------------

/**
 * Execute one adoption cycle: construct a `manual`-source Proposal from
 * the supplied drift, compose `buildSqliteSinks` against the runtime's
 * open DBs (wired to the real candidate patch applier and host-level view
 * capture sink), and call `adopt()`. Returns the `AdoptionResult` so the
 * caller can render it (one-line summary for serve, full result for sync)
 * and decide its exit code.
 *
 * Errors from `adopt()` are NOT caught here — the engine's contract is
 * that structured failures land on `AdoptionResult.diagnostics` with
 * `adopted: false`, and the only throws are programmer errors or
 * unhandled exceptions from third-party processor code. The daemon
 * wraps its call in try/catch (one bad commit shouldn't crash a
 * long-running poll); `dome sync` lets the throw propagate (a one-shot
 * command crashing on an unexpected throw is the right loudness).
 */
export async function runOneAdoption(opts: {
  readonly runtime: VaultRuntime;
  readonly drift: DriftInfo;
  /**
   * Optional clock injection. Defaults to `() => new Date()` (real
   * time). The harness's `tick()` passes its `TestClock`'s `now`
   * callback so scenarios can advance time deterministically and
   * observe schedule triggers fire predictably. Phase 4c.
   */
  readonly now?: () => Date;
  /**
   * Optional observability callback forwarded to `adopt()` — surfaces
   * per-iteration + per-processor events for verbose-mode CLI rendering.
   * `dome serve --verbose` / `dome sync --verbose` wire a callback that
   * prints each event; default callers pass nothing.
   */
  readonly onEvent?: (event: AdoptEvent) => void;
}): Promise<AdoptionResult> {
  const locked = await withCompilerHostBranchLock(
    {
      vaultPath: opts.runtime.path,
      branch: opts.drift.branch,
      command: "compiler-host-run-one-adoption",
    },
    () => runAdoptionCycle(opts),
  );
  if (locked.kind === "busy") {
    throw new Error(
      `compiler host lock busy for branch ${locked.branch} at ${locked.lockPath}`,
    );
  }
  return locked.value.adoption;
}

async function runAdoptionCycle(opts: {
  readonly runtime: VaultRuntime;
  readonly drift: DriftInfo;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: AdoptEvent) => void;
  readonly onGardenProcessorStart?: (info: GardenProcessorStart) => void;
}): Promise<CompilerHostAdoptionCycleResult> {
  const { runtime, drift, onEvent } = opts;
  const now = opts.now ?? ((): Date => new Date());

  const proposal = makeManualProposal({
    base: drift.base,
    head: drift.head,
    branch: drift.branch,
  });

  const vault = runtimeVault(runtime);
  const sinksFor = sinksForRuntime(runtime, now);

  const sinks = sinksFor({ base: proposal.base, head: proposal.head });

  const adoptOpts: {
    vault: typeof vault;
    proposal: typeof proposal;
    runAdoptionProcessors: typeof runtime.processorRuntime.adoptionRunner;
    sinks: ApplyEffectSinks;
    ledger: typeof runtime.ledgerDb;
    maxIterations: number;
    onEvent?: (event: AdoptEvent) => void;
  } = {
    vault,
    proposal,
    runAdoptionProcessors: runtime.processorRuntime.adoptionRunner,
    sinks,
    ledger: runtime.ledgerDb,
    maxIterations: runtime.config.engine.maxIterations,
  };
  if (onEvent !== undefined) adoptOpts.onEvent = onEvent;
  const adoptionResult = await adopt(adoptOpts);

  let garden: GardenPhaseResult | null = null;
  let operational: OperationalWorkResult | null = null;
  let projectionRebuild: ProjectionRebuildResult | null = null;
  const cursor: AdoptedCursor = { current: adoptionResult.adoptedRef };

  if (adoptionResult.adopted) {
    const adoptedCompiled = await compileRange({
      vaultPath: runtime.path,
      base: drift.base,
      head: adoptionResult.adoptedRef,
    });
    projectionRebuild = await rebuildProjectionAfterAdoption({
      runtime,
      adopted: adoptionResult.adoptedRef,
      branch: drift.branch,
      initialBootstrap: drift.base === drift.head,
      globalConfigChanged:
        projectionGlobalConfigChanged(adoptedCompiled.changedPaths) ||
        adoptionProjectionFlushFailed(adoptionResult),
      now,
    });

    const adoptSubProposal = makeAdoptSubProposal({
      runtime,
      vault: adoptOpts.vault,
      sinksFor,
      cursor,
      now,
      ...(onEvent !== undefined ? { onEvent } : {}),
      ...(opts.onGardenProcessorStart !== undefined
        ? { onGardenProcessorStart: opts.onGardenProcessorStart }
        : {}),
    });
    garden = await runGardenPhase({
      vault: adoptOpts.vault,
      proposal,
      adopted: adoptionResult.adoptedRef,
      changedPaths: adoptedCompiled.changedPaths,
      signals: adoptedCompiled.signals,
      runGardenProcessors: runtime.processorRuntime.gardenRunner,
      sinks: sinksForCursor({ sinksFor, cursor }),
      ledger: runtime.ledgerDb,
      adoptSubProposal,
      currentAdopted: () => cursor.current,
      extensionIdFor: runtime.extensionIdFor,
      cascadeDepth: 0,
      now,
      ...(opts.onGardenProcessorStart !== undefined
        ? { onProcessorStart: opts.onGardenProcessorStart }
        : {}),
    });

    operational = await runOperationalWorkForAdoptedUnlocked({
      runtime,
      adopted: cursor.current,
      now,
      adoptSubProposal,
      cursor,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    if (cursor.current !== adoptionResult.adoptedRef) {
      projectionRebuild =
        await rebuildProjectionIfGlobalConfigChanged({
          runtime,
          base: adoptionResult.adoptedRef,
          head: cursor.current,
          branch: drift.branch,
          now,
        }) ?? projectionRebuild;
    }

    await markProjectionBuiltForRuntime(runtime, {
      adoptedCommit: cursor.current,
      builtAt: now(),
    });
  }

  return Object.freeze({
    adoption: adoptionResult,
    garden,
    operational,
    finalAdoptedRef: cursor.current,
    projectionRebuild,
  });
}

export async function runOperationalWorkForAdopted(opts: {
  readonly runtime: VaultRuntime;
  readonly adopted: CommitOid;
  readonly branch?: string;
  readonly now?: () => Date;
  readonly sinks?: ApplyEffectSinks;
  readonly adoptSubProposal?: AdoptSubProposalFn;
  readonly cursor?: AdoptedCursor;
  readonly signal?: AbortSignal;
}): Promise<OperationalWorkResult> {
  if (opts.branch !== undefined) {
    const locked = await withCompilerHostBranchLock(
      {
        vaultPath: opts.runtime.path,
        branch: opts.branch,
        command: "compiler-host-operational",
      },
      () => runOperationalWorkForAdoptedUnlocked(opts),
    );
    if (locked.kind === "busy") {
      throw new Error(
        `compiler host lock busy for branch ${locked.branch} at ${locked.lockPath}`,
      );
    }
    return locked.value;
  }

  return runOperationalWorkForAdoptedUnlocked(opts);
}

async function runOperationalWorkForAdoptedUnlocked(opts: {
  readonly runtime: VaultRuntime;
  readonly adopted: CommitOid;
  readonly branch?: string;
  readonly now?: () => Date;
  readonly sinks?: ApplyEffectSinks;
  readonly adoptSubProposal?: AdoptSubProposalFn;
  readonly cursor?: AdoptedCursor;
  readonly signal?: AbortSignal;
}): Promise<OperationalWorkResult> {
  const now = opts.now ?? ((): Date => new Date());
  const cursor = opts.cursor ?? { current: opts.adopted };
  if (opts.branch !== undefined) {
    await rebuildProjectionIfStale({
      runtime: opts.runtime,
      adopted: cursor.current,
      branch: opts.branch,
      now,
    });
  }
  const vault = runtimeVault(opts.runtime);
  const sinksFor = sinksForRuntime(opts.runtime, now);
  const sinks =
    opts.sinks ?? sinksForCursor({ sinksFor, cursor });
  const adoptSubProposal =
    opts.adoptSubProposal ??
    makeAdoptSubProposal({
      runtime: opts.runtime,
      vault,
      sinksFor,
      cursor,
      now,
    });

  const beforeOperational = cursor.current;
  const result = await runOperationalWork({
    vault,
    adopted: cursor.current,
    registry: opts.runtime.registry,
    projection: opts.runtime.projectionDb,
    answers: opts.runtime.answersDb,
    outbox: opts.runtime.outboxDb,
    sinks,
    resolveTree: makeResolveTree(opts.runtime.path),
    now,
    ledger: opts.runtime.ledgerDb,
    executionState: opts.runtime.processorRuntime.executionState,
    executionCap: opts.runtime.config.engine.executionCap,
    operational: operationalQueryViewForRuntime(opts.runtime, now),
    ...(opts.runtime.modelProvider !== undefined
      ? { modelProvider: opts.runtime.modelProvider }
      : {}),
    ...(opts.runtime.modelStepProvider !== undefined
      ? { modelStepProvider: opts.runtime.modelStepProvider }
      : {}),
    resolveGrants: opts.runtime.resolveGrants,
    extensionIdFor: opts.runtime.extensionIdFor,
    extensionConfigFor: opts.runtime.extensionConfigFor,
    externalHandlers: opts.runtime.externalHandlers,
    questionAutoResolve: opts.runtime.config.engine.autoResolveQuestions,
    adoptSubProposal,
    currentAdopted: () => cursor.current,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  if (opts.branch !== undefined && cursor.current !== beforeOperational) {
    await rebuildProjectionIfGlobalConfigChanged({
      runtime: opts.runtime,
      base: beforeOperational,
      head: cursor.current,
      branch: opts.branch,
      now,
    });
    await markProjectionBuiltForRuntime(opts.runtime, {
      adoptedCommit: cursor.current,
      builtAt: now(),
    });
  }

  return result;
}

function operationalQueryViewForRuntime(
  runtime: VaultRuntime,
  now: () => Date,
) {
  return buildOperationalQueryView({
    outbox: runtime.outboxDb,
    ledger: runtime.ledgerDb,
    executionState: runtime.processorRuntime.executionState,
    now,
  });
}

export type AnswerHandlersForQuestionResult =
  | {
      readonly kind: "handled";
      readonly adopted: CommitOid;
      readonly result: AnswerHandlerResult;
    }
  | {
      readonly kind: "skipped";
      readonly reason: "detached-head" | "no-adopted-ref";
    };

export async function runAnswerHandlersForQuestion(opts: {
  readonly runtime: VaultRuntime;
  readonly question: QuestionRecord;
}): Promise<AnswerHandlersForQuestionResult> {
  const branch = await getCurrentBranch(opts.runtime.path);
  if (branch === null) {
    return Object.freeze({ kind: "skipped" as const, reason: "detached-head" });
  }
  const locked = await withCompilerHostBranchLock(
    {
      vaultPath: opts.runtime.path,
      branch,
      command: "compiler-host-answer-handlers",
    },
    () => runAnswerHandlersForQuestionUnlocked({ ...opts, branch }),
  );
  if (locked.kind === "busy") {
    throw new Error(
      `compiler host lock busy for branch ${locked.branch} at ${locked.lockPath}`,
    );
  }
  return locked.value;
}

async function runAnswerHandlersForQuestionUnlocked(opts: {
  readonly runtime: VaultRuntime;
  readonly question: QuestionRecord;
  readonly branch: string;
}): Promise<AnswerHandlersForQuestionResult> {
  const { branch } = opts;
  const adoptedRaw = await getAdoptedRef(opts.runtime.path, branch);
  if (adoptedRaw === null) {
    return Object.freeze({ kind: "skipped" as const, reason: "no-adopted-ref" });
  }

  const adopted = commitOid(adoptedRaw);
  const vault = runtimeVault(opts.runtime);
  const sinksFor = sinksForRuntime(opts.runtime);
  const cursor: AdoptedCursor = { current: adopted };
  const sinks = sinksForCursor({ sinksFor, cursor });
  const adoptSubProposal = makeAdoptSubProposal({
    runtime: opts.runtime,
    vault,
    sinksFor,
    cursor,
  });
  const now = (): Date => new Date();
  const beforeHandlers = cursor.current;

  const result = await runAnswerHandlers({
    vault,
    adopted,
    registry: opts.runtime.registry,
    question: opts.question,
    sinks,
    resolveTree: makeResolveTree(opts.runtime.path),
    resolveGrants: opts.runtime.resolveGrants,
    extensionIdFor: opts.runtime.extensionIdFor,
    ledger: opts.runtime.ledgerDb,
    executionState: opts.runtime.processorRuntime.executionState,
    executionCap: opts.runtime.config.engine.executionCap,
    operational: opts.runtime.operationalQueryView,
    ...(opts.runtime.modelProvider !== undefined
      ? { modelProvider: opts.runtime.modelProvider }
      : {}),
    ...(opts.runtime.modelStepProvider !== undefined
      ? { modelStepProvider: opts.runtime.modelStepProvider }
      : {}),
    adoptSubProposal,
    currentAdopted: () => cursor.current,
  });

  if (cursor.current !== beforeHandlers) {
    await rebuildProjectionIfGlobalConfigChanged({
      runtime: opts.runtime,
      base: beforeHandlers,
      head: cursor.current,
      branch,
      now,
    });
    await markProjectionBuiltForRuntime(opts.runtime, {
      adoptedCommit: cursor.current,
      builtAt: now(),
    });
  }

  return Object.freeze({
    kind: "handled" as const,
    adopted: cursor.current,
    result,
  });
}

export async function rebuildProjectionIfStale(opts: {
  readonly runtime: VaultRuntime;
  readonly adopted: CommitOid;
  readonly branch: string;
  readonly now?: () => Date;
}): Promise<ProjectionRebuildResult | null> {
  if (
    !projectionRequiresRebuild(opts.runtime.projectionDb, {
      adoptedCommit: opts.adopted,
      extensionSet: opts.runtime.extensions,
      processorVersions: opts.runtime.processorVersions,
      capabilityPolicyHash: opts.runtime.capabilityPolicyHash,
    })
  ) {
    return null;
  }

  return rebuildProjection({
    runtime: opts.runtime,
    adopted: opts.adopted,
    branch: opts.branch,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}

async function rebuildProjectionAfterAdoption(opts: {
  readonly runtime: VaultRuntime;
  readonly adopted: CommitOid;
  readonly branch: string;
  readonly initialBootstrap: boolean;
  readonly globalConfigChanged: boolean;
  readonly now?: () => Date;
}): Promise<ProjectionRebuildResult | null> {
  if (
    !opts.initialBootstrap &&
    !opts.globalConfigChanged &&
    !projectionCacheKeysChanged(opts.runtime.projectionDb, {
      extensionSet: opts.runtime.extensions,
      processorVersions: opts.runtime.processorVersions,
      capabilityPolicyHash: opts.runtime.capabilityPolicyHash,
    })
  ) {
    return null;
  }

  return rebuildProjection({
    runtime: opts.runtime,
    adopted: opts.adopted,
    branch: opts.branch,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}

function projectionGlobalConfigChanged(
  changedPaths: ReadonlyArray<string>,
): boolean {
  return changedPaths.some((path) => PROJECTION_GLOBAL_CONFIG_PATHS.has(path));
}

function adoptionProjectionFlushFailed(result: AdoptionResult): boolean {
  return result.diagnostics.some(
    (diagnostic) => diagnostic.code === "adoption.projection-flush-failed",
  );
}

async function rebuildProjectionIfGlobalConfigChanged(opts: {
  readonly runtime: VaultRuntime;
  readonly base: CommitOid;
  readonly head: CommitOid;
  readonly branch: string;
  readonly now: () => Date;
}): Promise<ProjectionRebuildResult | null> {
  const compiled = await compileRange({
    vaultPath: opts.runtime.path,
    base: opts.base,
    head: opts.head,
  });
  if (!projectionGlobalConfigChanged(compiled.changedPaths)) return null;

  return rebuildProjection({
    runtime: opts.runtime,
    adopted: opts.head,
    branch: opts.branch,
    now: opts.now,
  });
}

async function latestAdoptedOr(
  vaultPath: string,
  branch: string,
  fallback: CommitOid,
): Promise<CommitOid> {
  const raw = await getAdoptedRef(vaultPath, branch);
  return raw === null ? fallback : commitOid(raw);
}

function runtimeVault(runtime: VaultRuntime): {
  readonly path: string;
  readonly config: VaultRuntime["config"];
} {
  return {
    path: runtime.path,
    config: runtime.config,
  };
}

// Sinks are frame-aware: each Proposal/sub-Proposal gets its own
// `(base, head)` pair so engine commit trailers and projection rows are
// keyed to the proposal that actually produced them.
function sinksForRuntime(
  runtime: VaultRuntime,
  now?: () => Date,
): (
  frame: { readonly base: CommitOid; readonly head: CommitOid },
) => ApplyEffectSinks {
  return (frame) => {
    const realApplyPatch: ApplyEffectSinks["applyPatch"] = async ({
      effect,
      processorId,
      runId,
      candidate,
    }) => {
      // Only `mode: "auto"` patches mutate the candidate tree in the
      // adoption phase. `applyEffect` blocks `mode: "propose"` before it
      // reaches this sink; this guard is defensive so a direct sink call
      // still cannot land a review-required patch inline.
      if (effect.mode !== "auto") return null;

      const result = await applyPatchToCandidate({
        vaultPath: runtime.path,
        candidate,
        patch: effect,
        runContext: {
          runId,
          processorId,
          extensionId: runtime.extensionIdFor(processorId),
          base: frame.base,
          sourceHead: frame.head,
        },
        ...(now !== undefined ? { now } : {}),
      });

      return result;
    };

    return buildSqliteSinks({
      projectionDb: runtime.projectionDb,
      outboxDb: runtime.outboxDb,
      adoptedCommit: frame.head,
      projectionWriteLock: (fn) =>
        withProjectionWriteLock(
          { vaultPath: runtime.path, command: "projection-sink" },
          fn,
        ),
      applyPatch: realApplyPatch,
      captureView: captureViewPlaceholder,
      externalHandlers: runtime.externalHandlers,
      recoverQuarantine: async ({ effect }) => {
        runtime.processorRuntime.executionState.clearQuarantineIfCurrent({
          phase: effect.phase,
          processorId: effect.processorId,
          processorVersion: effect.processorVersion,
          triggerHash: effect.triggerHash,
          quarantineId: effect.quarantineId,
          quarantinedAt: new Date(effect.quarantinedAt),
          consecutiveRetryableFailures:
            effect.consecutiveRetryableFailures,
        });
      },
      recoverRun: async ({ effect }) => {
        return failRunIfCurrent(runtime.ledgerDb, {
          id: effect.runId,
          startedAt: effect.startedAt,
          processorId: effect.processorId,
          processorVersion: effect.processorVersion,
          phase: effect.phase,
          error: effect.reason,
          finishedAt: new Date(),
        });
      },
    });
  };
}

async function markProjectionBuiltForRuntime(
  runtime: VaultRuntime,
  opts: {
    readonly adoptedCommit: CommitOid;
    readonly builtAt: Date;
  },
): Promise<void> {
  await withProjectionWriteLock(
    { vaultPath: runtime.path, command: "projection-mark-built" },
    async () => {
      markProjectionBuilt(runtime.projectionDb, {
        adoptedCommit: opts.adoptedCommit,
        extensionSet: runtime.extensions,
        processorVersions: runtime.processorVersions,
        capabilityPolicyHash: runtime.capabilityPolicyHash,
        builtAt: opts.builtAt,
      });
    },
  );
}

function sinksForCursor(opts: {
  readonly sinksFor: ReturnType<typeof sinksForRuntime>;
  readonly cursor: AdoptedCursor;
}): ApplyEffectSinks {
  const current = (): ApplyEffectSinks =>
    opts.sinksFor({ base: opts.cursor.current, head: opts.cursor.current });

  return Object.freeze({
    applyPatch: async (input) => current().applyPatch(input),
    captureView: async (input) => current().captureView(input),
    recordDiagnostic: async (input) => current().recordDiagnostic(input),
    resolveDiagnostics: async (input) =>
      current().resolveDiagnostics?.(input),
    resolveFacts: async (input) => current().resolveFacts?.(input),
    resolveQuestions: async (input) => current().resolveQuestions?.(input),
    recordFact: async (input) => current().recordFact(input),
    recordSearchDocument: async (input) =>
      current().recordSearchDocument(input),
    recordQuestion: async (input) => current().recordQuestion(input),
    enqueueJob: async (input) => current().enqueueJob(input),
    dispatchExternal: async (input) => current().dispatchExternal(input),
    recoverOutbox: async (input) => current().recoverOutbox(input),
    recoverQuarantine: async (input) => current().recoverQuarantine(input),
    recoverRun: async (input) => current().recoverRun(input),
  } satisfies ApplyEffectSinks);
}

// Garden patches can spawn sub-Proposals recursively. The closure is
// shared by the primary garden phase, scheduled garden work, and queued
// jobs so every patch route lands back on the same adoption boundary.
function makeAdoptSubProposal(opts: {
  readonly runtime: VaultRuntime;
  readonly vault: ReturnType<typeof runtimeVault>;
  readonly sinksFor: ReturnType<typeof sinksForRuntime>;
  readonly cursor?: AdoptedCursor;
  readonly now?: () => Date;
  readonly onEvent?: (event: AdoptEvent) => void;
  readonly onGardenProcessorStart?: (info: GardenProcessorStart) => void;
}): AdoptSubProposalFn {
  const adoptSubProposal: AdoptSubProposalFn = async (
    subProposal,
    cascadeDepth,
  ) => {
    const subSinks = opts.sinksFor({
      base: subProposal.base,
      head: subProposal.head,
    });
    const subAdoptOpts: {
      vault: typeof opts.vault;
      proposal: typeof subProposal;
      runAdoptionProcessors: typeof opts.runtime.processorRuntime.adoptionRunner;
      sinks: ApplyEffectSinks;
      ledger: typeof opts.runtime.ledgerDb;
      maxIterations: number;
      onEvent?: (event: AdoptEvent) => void;
    } = {
      vault: opts.vault,
      proposal: subProposal,
      runAdoptionProcessors: opts.runtime.processorRuntime.adoptionRunner,
      sinks: subSinks,
      ledger: opts.runtime.ledgerDb,
      maxIterations: opts.runtime.config.engine.maxIterations,
    };
    if (opts.onEvent !== undefined) subAdoptOpts.onEvent = opts.onEvent;
    const subResult = await adopt(subAdoptOpts);
    if (subResult.adopted) {
      if (opts.cursor !== undefined) {
        opts.cursor.current = subResult.adoptedRef;
      }
      const subCompiled = await compileRange({
        vaultPath: opts.runtime.path,
        base: subProposal.base,
        head: subResult.adoptedRef,
      });
      const cursor = opts.cursor;
      const currentAdopted =
        cursor === undefined ? undefined : ((): CommitOid => cursor.current);
      const gardenSinks =
        cursor === undefined
          ? opts.sinksFor({
              base: subResult.adoptedRef,
              head: subResult.adoptedRef,
            })
          : sinksForCursor({ sinksFor: opts.sinksFor, cursor });
      await runGardenPhase({
        vault: subAdoptOpts.vault,
        proposal: subProposal,
        adopted: subResult.adoptedRef,
        changedPaths: subCompiled.changedPaths,
        signals: subCompiled.signals,
        runGardenProcessors: opts.runtime.processorRuntime.gardenRunner,
        sinks: gardenSinks,
        ledger: opts.runtime.ledgerDb,
        adoptSubProposal,
        ...(currentAdopted !== undefined ? { currentAdopted } : {}),
        extensionIdFor: opts.runtime.extensionIdFor,
        cascadeDepth,
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        ...(opts.onGardenProcessorStart !== undefined
          ? { onProcessorStart: opts.onGardenProcessorStart }
          : {}),
      });
    }
    return subResult;
  };
  return adoptSubProposal;
}

// ----- View-effect guard -----------------------------------------------------

/**
 * Compiler-host ticks do not render view output. Command-triggered view
 * processors run through `src/engine/view-command.ts`, where their
 * ViewEffects are captured and returned to the surface adapter. This sink is
 * a defensive guard for any ViewEffect that somehow reaches adoption, garden,
 * answer, job, or operational routing; phase compatibility should reject those
 * effects before the sink is called.
 */
const captureViewPlaceholder: ApplyEffectSinks["captureView"] =
  async () => undefined;
