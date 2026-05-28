// cli/commands/sync-shared: drift detection + one-shot adoption invocation.
//
// Shared by `dome serve` (Phase 11b daemon — calls these in a poll loop)
// and `dome sync` (Phase 11c catch-up — calls them exactly once). Both
// commands surface the same underlying operation:
//
//   1. Compare working-tree HEAD to `refs/dome/adopted/<branch>`.
//   2. If drift is present, construct a `manual`-source Proposal and run
//      `adopt()` against the open `VaultRuntime`.
//
// Extracting this here keeps the two callers structurally aligned — the
// daemon's per-tick body and the one-shot command's body are the same
// function call, just invoked under different lifecycles. Refactoring
// invariants:
//
//   - **Behavior preservation.** The daemon must continue to exhibit the
//     same per-tick semantics it had pre-extraction: detect drift,
//     synthesize the (HEAD, HEAD) empty-diff init when the adopted ref is
//     null, build the Proposal, run adopt, print a one-line summary.
//   - **No new substrate.** Same sinks (`buildSqliteSinks` against the
//     runtime's open DBs), same placeholder `applyPatch` / `captureView`
//     (log + drop — the candidate-tree mutator + view-effect delivery
//     wiring lands in v1.1).
//
// House-style notes (matches src/cli/commands/serve.ts):
//   - `type X = { ... }` aliases, every field `readonly`.
//   - Module-private: not re-exported from `src/index.ts`. Only the two
//     CLI commands import it.
//   - The placeholder sinks live here so both commands share the same
//     v1.0 behavior; if v1.1 wires real sinks it lands at this seam.

import { fileURLToPath } from "node:url";

import { commitOid, type CommitOid } from "../../core/source-ref";
import { makeManualProposal, type AdoptionResult } from "../../core/proposal";
import { adopt, type AdoptEvent } from "../../engine/adopt";
import { applyPatchToCandidate } from "../../engine/apply-patch";
import { compileRange } from "../../engine/compile-range";
import {
  runGardenPhase,
  type AdoptSubProposalFn,
} from "../../engine/garden";
import { runScheduler } from "../../engine/scheduler";
import {
  defaultExtensionIdFor,
  defaultResolveGrants,
  makeResolveTree,
  type VaultRuntime,
} from "../../engine/vault-runtime";
import { deriveExtensionId } from "../../extensions/id-helpers";
import { buildSqliteSinks } from "../../projections/sinks";
import { getAdoptedRef, getCurrentBranch } from "../../adopted-ref";
import { currentSha } from "../../git";

import type { ApplyEffectSinks } from "../../engine/apply-effect";

// ----- Shipped-bundles resolver --------------------------------------------

/**
 * Returns the absolute path to the SDK's shipped first-party bundles
 * directory (`<SDK>/assets/extensions/`).
 *
 * Resolved relative to this module's location via `import.meta.url`, so
 * the math works regardless of where the user installed the SDK (global
 * `bun install -g`, local `node_modules`, `bun link` symlink, or a
 * `bun build`-produced single-file). From
 * `src/cli/commands/sync-shared.ts`, three directories up reaches the
 * SDK package root; `assets/extensions/` is the canonical shipped-bundles
 * dir holding `dome.lint/` and `dome.markdown/`.
 *
 * This is the default `bundlesRoot` for every CLI command (`serve`,
 * `sync`, `doctor`, `status`). Users override via `--bundles-root <path>`
 * to point at vault-local bundles or a third-party install.
 *
 * Per docs/v1.md §"Vault" + §10.1, the vault carries `.dome/config.yaml`
 * (activations + grants); the bundle code lives in the SDK or in user-
 * installed third-party packages. The vault directory does not need to
 * contain `.dome/extensions/` for the shipped bundles to load.
 */
export function resolveShippedBundlesRoot(): string {
  // `src/cli/commands/sync-shared.ts` → SDK root is three directories up.
  const url = new URL("../../../assets/extensions", import.meta.url);
  return fileURLToPath(url);
}

// ----- Public types ---------------------------------------------------------

/**
 * The (base, head, branch) triple that names a single drift range. The
 * daemon's poll body builds this on every tick that detects drift; `dome
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

// ----- Verbose event formatter ---------------------------------------------

export type { AdoptEvent };

/**
 * Format an `AdoptEvent` as a single human-readable stdout line for
 * `dome serve --verbose` / `dome sync --verbose`. Lines are indented
 * under the daemon's top-level summary so the iteration structure is
 * scannable.
 *
 * The format is human-targeted (not machine-parseable); structured
 * consumers should query the run-ledger + projection DBs directly.
 */
export function formatAdoptEvent(event: AdoptEvent): string {
  switch (event.kind) {
    case "iteration-start":
      return (
        `dome serve:   iteration ${event.iteration}: ` +
        `${event.changedPathCount} changed path${event.changedPathCount === 1 ? "" : "s"}, ` +
        `${event.signalCount} signal${event.signalCount === 1 ? "" : "s"}`
      );
    case "processor-result":
      return (
        `dome serve:     ↳ ${event.processorId}: ` +
        `${event.effectCount} effect${event.effectCount === 1 ? "" : "s"}`
      );
    case "iteration-end":
      return event.converged
        ? `dome serve:   iteration ${event.iteration}: converged`
        : `dome serve:   iteration ${event.iteration}: ` +
          `${event.autoPatchCount} auto-patch${event.autoPatchCount === 1 ? "" : "es"} accumulated → re-iterating`;
  }
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
  const { runtime, drift, onEvent } = opts;
  const now = opts.now ?? ((): Date => new Date());

  const proposal = makeManualProposal({
    base: drift.base,
    head: drift.head,
    branch: drift.branch,
  });

  const vault = {
    path: runtime.path,
    config: { git: { auto_commit_workflows: true } },
  };

  // Phase 4a' fix-up: sinks and the `applyPatch` closure are
  // frame-aware — each carries the `(base, head)` of the specific
  // Proposal being adopted. Building them per-Proposal (rather than
  // once at runOneAdoption entry and reusing for sub-Proposals)
  // ensures the engine commits stamped during sub-Proposal adoption
  // carry the *sub*-Proposal's base/sourceHead in their Dome-* trailers
  // (per [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]]) and
  // projection rows emitted during sub-adoption are keyed to the
  // sub-Proposal's adopted commit (per [[wiki/specs/projection-store]]
  // §"Cache key"). The pre-fix-up shape captured `drift.base`/
  // `drift.head` once and reused them recursively — incorrect.
  const sinksFor = (frame: { base: CommitOid; head: CommitOid }): ApplyEffectSinks => {
    const realApplyPatch: ApplyEffectSinks["applyPatch"] = async ({
      effect,
      processorId,
      runId,
      candidate,
    }) => {
      // Only `mode: "auto"` patches mutate the candidate tree in the
      // adoption phase. Per docs/wiki/specs/effects.md §"PatchEffect"
      // routing, `mode: "propose"` patches are surfaced as diagnostics
      // for human review (`dome lint --apply`) rather than landed inline.
      // Surfacing the propose-diagnostic is a separate seam (Phase 12b);
      // here we just drop the propose branch so the candidate doesn't
      // advance.
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
    });
  };

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

  // Phase 4a + 4a': invoke garden-phase processors after a successful
  // adoption, and recursively adopt garden-emitted sub-Proposals.
  //
  // Garden runs against the post-adoption signals computed from
  // `(proposal.base, adoptedRef)` — the full delta of what was just
  // adopted. Garden failures never undo adoption; outputs flow through
  // the normal sinks (projection.db / outbox.db / runs.db) and are
  // visible via `dome inspect` after the fact.
  //
  // The `adoptSubProposal` closure (defined below) threads the cascade
  // recursion: garden processors that emit auto-mode PatchEffects spawn
  // sub-Proposals; each sub-adoption fires its own garden phase at
  // `cascadeDepth + 1`; the cap is enforced at the orchestrator level
  // (per `DEFAULT_MAX_CASCADE_DEPTH`).
  //
  // Sub-Proposal sinks are built fresh per sub-Proposal frame via
  // `sinksFor(...)` so the projection-row `adopted_commit` column and
  // the engine-commit `Dome-Base` / `Dome-Source-Head` trailers are
  // correctly scoped to each sub-Proposal (Phase 4a' fix-up).
  //
  // See [[wiki/specs/processors]] §"Garden phase" and Phases 4a + 4a'
  // in [[cohesive/brainstorms/2026-05-27-v1-engine-completion]].
  if (adoptionResult.adopted) {
    // The recursive closure. `adoptSubProposal` references itself
    // inside its body; that works because the const binding is
    // initialized before the runGardenPhase call below reads it (the
    // body executes only when called).
    const adoptSubProposal: AdoptSubProposalFn = async (
      subProposal,
      cascadeDepth,
    ) => {
      const subSinks = sinksFor({
        base: subProposal.base,
        head: subProposal.head,
      });
      const subAdoptOpts: typeof adoptOpts = {
        ...adoptOpts,
        proposal: subProposal,
        sinks: subSinks,
      };
      const subResult = await adopt(subAdoptOpts);
      if (subResult.adopted) {
        const subCompiled = await compileRange({
          vaultPath: runtime.path,
          base: subProposal.base,
          head: subResult.adoptedRef,
        });
        await runGardenPhase({
          vault: subAdoptOpts.vault,
          proposal: subProposal,
          adopted: subResult.adoptedRef,
          changedPaths: subCompiled.changedPaths,
          signals: subCompiled.signals,
          runGardenProcessors: runtime.processorRuntime.gardenRunner,
          sinks: subSinks,
          ledger: runtime.ledgerDb,
          adoptSubProposal,
          cascadeDepth,
        });
      }
      return subResult;
    };

    const gardenCompiled = await compileRange({
      vaultPath: runtime.path,
      base: drift.base,
      head: adoptionResult.adoptedRef,
    });
    await runGardenPhase({
      vault: adoptOpts.vault,
      proposal,
      adopted: adoptionResult.adoptedRef,
      changedPaths: gardenCompiled.changedPaths,
      signals: gardenCompiled.signals,
      runGardenProcessors: runtime.processorRuntime.gardenRunner,
      sinks,
      ledger: runtime.ledgerDb,
      adoptSubProposal,
      cascadeDepth: 0,
    });

    // Phase 4c: run the scheduler against the just-adopted state. Fires
    // any garden / view processors whose `schedule:` triggers are due
    // per `projection.db.schedule_cursors`. Runs ONCE per top-level
    // adoption attempt (not per sub-Proposal — schedule semantics are
    // "what's due since last fire," independent of cascade depth).
    // See [[wiki/specs/processors]] §"Triggers and signals" + Phase 4c
    // in [[cohesive/brainstorms/2026-05-27-v1-engine-completion]].
    await runScheduler({
      vault: adoptOpts.vault,
      adopted: adoptionResult.adoptedRef,
      registry: runtime.registry,
      projection: runtime.projectionDb,
      sinks,
      resolveTree: makeResolveTree(runtime.path),
      now,
      ledger: runtime.ledgerDb,
      resolveGrants: defaultResolveGrants(runtime.registry),
      extensionIdFor: defaultExtensionIdFor,
    });
  }

  return adoptionResult;
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
