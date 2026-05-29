// engine/compiler-host: runtime host operations over an open VaultRuntime.
//
// CLI commands, the harness, and future non-CLI surfaces share the same
// drift/adoption path:
//
//   1. Compare working-tree HEAD to `refs/dome/adopted/<branch>`.
//   2. If drift is present, construct a `manual`-source Proposal and run
//      `adopt()` against the open `VaultRuntime`.
//
// `dome answer` also uses this module for the same runtime-host wiring:
// frame-aware SQLite sinks, adopted-ref resolution, and garden sub-Proposal
// adoption. Keeping those operations together prevents each CLI verb from
// hand-rolling a slightly different engine host.
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
//   - The placeholder captureView sink lives here so all background host
//     paths share one v1 behavior.

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
import {
  runOperationalWork,
  type OperationalWorkResult,
} from "./operational-work";
import {
  runAnswerHandlers,
  type AnswerHandlerResult,
} from "./answers";
import {
  makeResolveTree,
  type VaultRuntime,
} from "./vault-runtime";
import { deriveExtensionId } from "../extensions/id-helpers";
import {
  markProjectionBuilt,
  projectionCacheKeysChanged,
  projectionRequiresRebuild,
} from "../projections/db";
import { buildSqliteSinks } from "../projections/sinks";
import type { QuestionRecord } from "../projections/questions";
import { getAdoptedRef, getCurrentBranch } from "../adopted-ref";
import { currentSha } from "../git";
import type { ApplyEffectSinks } from "./apply-effect";
import { failRunIfCurrent } from "../ledger/runs";
import type { RunId } from "./runner-contract";

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
 * The discriminated outcome of `detectDrift`. Four variants:
 *
 *   - `drift`         — HEAD differs from the adopted ref (or the adopted
 *                       ref is uninitialized and the empty-diff init is
 *                       pending). Caller passes `info` to `runOneAdoption`.
 *   - `in-sync`       — adopted ref is initialized and equals HEAD; no
 *                       work to do.
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
export async function runCompilerHostTick(opts: {
  readonly runtime: VaultRuntime;
  readonly drift?: DriftResult;
  readonly now?: () => Date;
  readonly runOperationalWhenInSync?: boolean;
  readonly onEvent?: (event: AdoptEvent) => void;
}): Promise<CompilerHostTickResult> {
  const drift = opts.drift ?? await detectDrift(opts.runtime.path);
  const now = opts.now ?? ((): Date => new Date());

  if (drift.kind === "detached-head" || drift.kind === "no-commits") {
    return Object.freeze({ kind: drift.kind });
  }

  if (drift.kind === "in-sync") {
    let operational: OperationalWorkResult | null = null;
    if (opts.runOperationalWhenInSync !== false) {
      operational = await runOperationalWorkForAdopted({
        runtime: opts.runtime,
        adopted: drift.head,
        branch: drift.branch,
        now,
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
    ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
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

// ----- runOneAdoption -------------------------------------------------------

/**
 * Execute one adoption cycle: construct a `manual`-source Proposal from
 * the supplied drift, compose `buildSqliteSinks` against the runtime's
 * open DBs (wired to the v1.0 placeholder `applyPatch` / `captureView`
 * sinks), and call `adopt()`. Returns the `AdoptionResult` so the caller
 * can render it (one-line summary for serve, full result for sync) and
 * decide its exit code.
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
  return (await runAdoptionCycle(opts)).adoption;
}

async function runAdoptionCycle(opts: {
  readonly runtime: VaultRuntime;
  readonly drift: DriftInfo;
  readonly now?: () => Date;
  readonly onEvent?: (event: AdoptEvent) => void;
}): Promise<CompilerHostAdoptionCycleResult> {
  const { runtime, drift, onEvent } = opts;
  const now = opts.now ?? ((): Date => new Date());

  const proposal = makeManualProposal({
    base: drift.base,
    head: drift.head,
    branch: drift.branch,
  });

  const vault = runtimeVault(runtime);
  const sinksFor = sinksForRuntime(runtime);

  const sinks = sinksFor({ base: proposal.base, head: proposal.head });

  const adoptOpts: {
    vault: typeof vault;
    proposal: typeof proposal;
    runAdoptionProcessors: typeof runtime.processorRuntime.adoptionRunner;
    sinks: ApplyEffectSinks;
    ledger: typeof runtime.ledgerDb;
    onEvent?: (event: AdoptEvent) => void;
  } = {
    vault,
    proposal,
    runAdoptionProcessors: runtime.processorRuntime.adoptionRunner,
    sinks,
    ledger: runtime.ledgerDb,
  };
  if (onEvent !== undefined) adoptOpts.onEvent = onEvent;
  const adoptionResult = await adopt(adoptOpts);

  let garden: GardenPhaseResult | null = null;
  let operational: OperationalWorkResult | null = null;
  let projectionRebuild: ProjectionRebuildResult | null = null;
  const cursor: AdoptedCursor = { current: adoptionResult.adoptedRef };

  if (adoptionResult.adopted) {
    projectionRebuild = await rebuildProjectionIfCacheKeysChanged({
      runtime,
      adopted: adoptionResult.adoptedRef,
      branch: drift.branch,
      now,
    });

    const adoptSubProposal = makeAdoptSubProposal({
      runtime,
      vault: adoptOpts.vault,
      sinksFor,
      cursor,
      ...(onEvent !== undefined ? { onEvent } : {}),
    });
    const gardenCompiled = await compileRange({
      vaultPath: runtime.path,
      base: drift.base,
      head: adoptionResult.adoptedRef,
    });
    garden = await runGardenPhase({
      vault: adoptOpts.vault,
      proposal,
      adopted: adoptionResult.adoptedRef,
      changedPaths: gardenCompiled.changedPaths,
      signals: gardenCompiled.signals,
      runGardenProcessors: runtime.processorRuntime.gardenRunner,
      sinks,
      ledger: runtime.ledgerDb,
      adoptSubProposal,
      currentAdopted: () => cursor.current,
      cascadeDepth: 0,
    });

    operational = await runOperationalWorkForAdopted({
      runtime,
      adopted: cursor.current,
      now,
      adoptSubProposal,
      cursor,
    });

    markProjectionBuilt(runtime.projectionDb, {
      adoptedCommit: cursor.current,
      extensionSet: runtime.extensions,
      processorVersions: runtime.processorVersions,
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
  const sinksFor = sinksForRuntime(opts.runtime);
  const sinks =
    opts.sinks ?? sinksForCursor({ sinksFor, cursor });
  const adoptSubProposal =
    opts.adoptSubProposal ??
    makeAdoptSubProposal({
      runtime: opts.runtime,
      vault,
      sinksFor,
      cursor,
    });

  return runOperationalWork({
    vault,
    adopted: cursor.current,
    registry: opts.runtime.registry,
    projection: opts.runtime.projectionDb,
    outbox: opts.runtime.outboxDb,
    sinks,
    resolveTree: makeResolveTree(opts.runtime.path),
    now,
    ledger: opts.runtime.ledgerDb,
    executionState: opts.runtime.processorRuntime.executionState,
    operational: opts.runtime.operationalQueryView,
    ...(opts.runtime.modelProvider !== undefined
      ? { modelProvider: opts.runtime.modelProvider }
      : {}),
    resolveGrants: opts.runtime.resolveGrants,
    extensionIdFor: opts.runtime.extensionIdFor,
    externalHandlers: opts.runtime.externalHandlers,
    adoptSubProposal,
    currentAdopted: () => cursor.current,
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
    operational: opts.runtime.operationalQueryView,
    ...(opts.runtime.modelProvider !== undefined
      ? { modelProvider: opts.runtime.modelProvider }
      : {}),
    adoptSubProposal,
    currentAdopted: () => cursor.current,
  });

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

async function rebuildProjectionIfCacheKeysChanged(opts: {
  readonly runtime: VaultRuntime;
  readonly adopted: CommitOid;
  readonly branch: string;
  readonly now?: () => Date;
}): Promise<ProjectionRebuildResult | null> {
  if (
    !projectionCacheKeysChanged(opts.runtime.projectionDb, {
      extensionSet: opts.runtime.extensions,
      processorVersions: opts.runtime.processorVersions,
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
  readonly config: { readonly git: { readonly auto_commit_workflows: true } };
} {
  return {
    path: runtime.path,
    config: { git: { auto_commit_workflows: true } },
  };
}

// Sinks are frame-aware: each Proposal/sub-Proposal gets its own
// `(base, head)` pair so engine commit trailers and projection rows are
// keyed to the proposal that actually produced them.
function sinksForRuntime(
  runtime: VaultRuntime,
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
          extensionId: deriveExtensionId(processorId),
          base: frame.base,
          sourceHead: frame.head,
        },
      });

      if (result === null) {
        console.warn(
          `dome: applyPatch dropped — patch from ${processorId} did not apply ` +
            `against candidate ${candidate.slice(0, 12)}`,
        );
      }

      return result;
    };

    return buildSqliteSinks({
      projectionDb: runtime.projectionDb,
      outboxDb: runtime.outboxDb,
      adoptedCommit: frame.head,
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
        failRunIfCurrent(runtime.ledgerDb, {
          id: effect.runId as RunId,
          startedAt: effect.startedAt,
          error: effect.reason,
          finishedAt: new Date(),
        });
      },
    });
  };
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
  readonly onEvent?: (event: AdoptEvent) => void;
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
      onEvent?: (event: AdoptEvent) => void;
    } = {
      vault: opts.vault,
      proposal: subProposal,
      runAdoptionProcessors: opts.runtime.processorRuntime.adoptionRunner,
      sinks: subSinks,
      ledger: opts.runtime.ledgerDb,
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
      await runGardenPhase({
        vault: subAdoptOpts.vault,
        proposal: subProposal,
        adopted: subResult.adoptedRef,
        changedPaths: subCompiled.changedPaths,
        signals: subCompiled.signals,
        runGardenProcessors: opts.runtime.processorRuntime.gardenRunner,
        sinks: subSinks,
        ledger: opts.runtime.ledgerDb,
        adoptSubProposal,
        ...(currentAdopted !== undefined ? { currentAdopted } : {}),
        cascadeDepth,
      });
    }
    return subResult;
  };
  return adoptSubProposal;
}

// `deriveExtensionId` moved to `src/extensions/id-helpers.ts` (Phase 4a'
// fix-up) so both this module and `src/engine/garden.ts` can share one
// source of truth for the convention. See the imported function for
// the full doc.

// ----- Placeholder sinks (v1.0) ---------------------------------------------

/**
 * `captureView` placeholder for v1.0. Logs + drops the effect; does NOT
 * throw. View-phase processors don't run inside the adoption loop in
 * v1.0, so this path only fires if an adoption-phase processor mis-
 * declares a ViewEffect (the broker rejects it via phase-mismatch
 * before reaching the sink, in practice).
 */
const captureViewPlaceholder: ApplyEffectSinks["captureView"] = async ({
  processorId,
}) => {
  console.warn(
    `dome: ViewEffect from ${processorId} dropped — captureView ` +
      `not yet wired in v1.0. View-effect delivery to CLI/MCP lands in v1.1.`,
  );
};
