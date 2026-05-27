// submitProposal: the single user-facing write entry point.
//
// Per [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]], every write
// into trusted vault state — human, agent, garden processor, scheduled job —
// flows through this function. It composes the v1 engine stack against a
// caller-opened `VaultRuntime`:
//
//   1. Read the three DBs (projection / outbox / ledger) from the runtime.
//   2. Build the seven-sink `ApplyEffectSinks` via `buildSqliteSinks`,
//      injecting Phase 7a placeholders for `applyPatch` and `captureView`
//      (the two sinks not owned by the projection / outbox factories — see
//      `src/projections/sinks.ts` §"Two sinks are injected by the caller").
//   3. Call `adopt({ vault, proposal, runAdoptionProcessors, sinks, ledger })`
//      and return its `AdoptionResult` verbatim.
//
// Idempotency: per [[wiki/specs/proposals]] §"Submission API" and the
// adoption-loop's fixed-point semantics, calling `submitProposal` twice
// with the same `proposal.id` and the same `(base, head)` short-circuits
// on the second call — the candidate tree is already at the proposal's
// head, so the loop converges on iteration 1 with no engine writes. The
// second call's `AdoptionResult.adopted` is `true` (the adopted ref is
// already at `head`); no observable side effect occurs.
//
// Lifecycle: `submitProposal` does NOT open DBs. `openVaultRuntime` (in
// `./vault-runtime.ts`) is the open-side; the caller passes the opened
// handle in. Separating DB-open from per-call API surface lets a single
// VaultRuntime serve many submissions without re-opening sqlite per call.
//
// Phase 7a placeholders (documented inline at injection):
//   - `applyPatch`: throws on invocation. Phase 7b wires the candidate-
//     tree mutator that turns a routed `PatchEffect` into either a
//     working-tree write (adoption phase) or a new garden-Proposal (per
//     [[wiki/matrices/effect-router-targets]]).
//   - `captureView`: throws on invocation. Phase 7b/8 wires the view-
//     effect delivery surface (CLI stdout, MCP response, HTTP stream).
// The Phase 7a smoke test exercises only effect kinds that don't drive
// these two sinks (diagnostic, fact, question), so the throws never fire.
//
// `resolveTree` (the third Phase 7a seam) is NOT a placeholder — see
// `./vault-runtime.ts`'s `makeResolveTree`. The runtime calls it
// unconditionally per iteration when adoption-phase processors exist,
// so a throwing stub would break every submission with a non-empty
// registry.
//
// Phase 7b will retire the old `src/vault.ts`'s Tools-surface (writeDocument,
// patchRegion, etc.). For Phase 7a, submitProposal is strictly additive on
// top of v1 substrate — it does not replace any existing API.
//
// House-style notes (matches src/engine/adopt.ts, src/projections/sinks.ts,
// src/engine/closure-commit.ts):
//   - Banner cites the normative spec + the load-bearing invariant.
//   - `type X = { ... }` aliases (not `interface`), every field `readonly`.
//   - Imports limited to v1 substrate: `./adopt`, `./vault-runtime`,
//     `./apply-effect` (for the placeholder sink types), the `Proposal`
//     and `AdoptionResult` types from `../core/proposal`, the sink
//     builder from `../projections/sinks`, and the engine-owned
//     `EngineVault` shape from `./vault-shape` (the minimal structural
//     type `adopt` consumes — see [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]
//     §"engine reads vault by shape, not by class").

import type {
  AdoptionResult,
  Proposal,
} from "../core/proposal";
import { buildSqliteSinks } from "../projections/sinks";
import { adopt } from "./adopt";
import type { ApplyEffectSinks } from "./apply-effect";
import type { EngineVault } from "./vault-shape";
import type { VaultRuntime } from "./vault-runtime";

// ----- Public types ---------------------------------------------------------

/**
 * The input shape for `submitProposal`. Both fields are required:
 *
 *   - `runtime` — the `VaultRuntime` handle returned by `openVaultRuntime`.
 *                 Holds the three open DBs and the built ProcessorRuntime.
 *   - `proposal` — already constructed via one of the five source
 *                  constructors (`clientProposal`, `agentProposal`,
 *                  `gardenProposal`, `manualProposal`, `importProposal`)
 *                  per [[wiki/specs/proposals]] §"Construction paths".
 *                  This function does not synthesize Proposals from
 *                  `SubmitInput`; callers that want that are expected to
 *                  go through a future `dome submit` CLI layer (Phase 8+).
 */
export type SubmitProposalOpts = {
  readonly runtime: VaultRuntime;
  readonly proposal: Proposal;
};

// ----- submitProposal -------------------------------------------------------

/**
 * Submit a Proposal for adoption. Returns the `AdoptionResult` from the
 * underlying `adopt()` call — `adopted: true` on a clean fixed point with
 * the adopted ref advanced; `adopted: false` with blocking diagnostics on
 * a divergent / blocked loop.
 *
 * The function never throws on expected adoption outcomes — `adopted:
 * false` is a normal terminal state. Programmer errors (e.g., a processor
 * whose `run` throws — caught by the runtime and synthesized into a
 * `processor-threw` diagnostic) likewise surface in `diagnostics` rather
 * than as a thrown exception. SQLite-level failures from the sinks
 * propagate (per `apply-effect.ts`'s "Errors a sink throws propagate up
 * to the caller" contract).
 *
 * @param opts.runtime   The opened VaultRuntime.
 * @param opts.proposal  The Proposal to adopt.
 */
export async function submitProposal(
  opts: SubmitProposalOpts,
): Promise<AdoptionResult> {
  const { runtime, proposal } = opts;

  // Build the seven-sink `ApplyEffectSinks`. Five sinks delegate to the
  // projection / outbox accessors; two are Phase 7a placeholders.
  //
  // `adoptedCommit` is threaded as `proposal.base` — the adopted ref at
  // construction time. Every fact / diagnostic / question / job row
  // written during this submission lands with `adopted_commit = base` per
  // [[wiki/specs/projection-store]] §"Tables" (`adopted_commit` column).
  // On a successful adoption, the post-call adopted ref advances to
  // either the closure-commit OID or `proposal.head`; subsequent calls
  // re-read it from the ref. Phase 7a's smoke test asserts the row is
  // present; the exact `adopted_commit` value is `proposal.base` and is
  // not part of the assertion surface.
  const sinks: ApplyEffectSinks = buildSqliteSinks({
    projectionDb: runtime.projectionDb,
    outboxDb: runtime.outboxDb,
    adoptedCommit: proposal.base,
    applyPatch: applyPatchPlaceholder,
    captureView: captureViewPlaceholder,
  });

  // Construct the minimal `EngineVault` shape `adopt()` consumes:
  //   - `path`                                 — for `currentSha`, `currentBranch`.
  //   - `config.git.auto_commit_workflows`     — read by `makeClosureCommit`.
  //
  // `EngineVault` (in `./vault-shape`) is the engine layer's own structural
  // type — the engine reads vaults by shape, not by class. The user-facing
  // `dome submit` CLI (Phase 8+) reads `auto_commit_workflows` from
  // `.dome/config.yaml`; here we enable closure commits so the adopted-ref
  // / dual-surface join lands the same way it does in the broader engine
  // tests.
  const vault: EngineVault = {
    path: runtime.path,
    config: {
      git: {
        auto_commit_workflows: true,
      },
    },
  };

  return adopt({
    vault,
    proposal,
    runAdoptionProcessors: runtime.processorRuntime.adoptionRunner,
    sinks,
    ledger: runtime.ledgerDb,
  });
}

// ----- Phase 7a placeholder sinks -------------------------------------------

/**
 * Phase 7a placeholder for `applyPatch`. Throws on invocation. Phase 7b
 * wires the real candidate-tree mutator that turns a routed `PatchEffect`
 * into either a working-tree write (adoption phase) or a new garden-
 * Proposal (per [[wiki/matrices/effect-router-targets]] §"Garden-emitted
 * Proposals").
 *
 * The Phase 7a smoke test exercises only diagnostic / fact / question
 * effects, which don't reach `applyPatch`. A processor that *does* emit
 * a `PatchEffect` during Phase 7a should fail loudly here rather than
 * silently no-op — the throw makes the gap visible.
 */
const applyPatchPlaceholder: ApplyEffectSinks["applyPatch"] = async () => {
  throw new Error(
    "submitProposal: applyPatch not yet wired — Phase 7b will inject the candidate-tree mutator. Phase 7a only exercises effect kinds that don't drive patch application.",
  );
};

/**
 * Phase 7a placeholder for `captureView`. Throws on invocation. ViewEffects
 * are rejected by phase in the adoption loop (per
 * [[wiki/matrices/effect-router-targets]] §"view"), so this throw fires
 * only if a misconfigured processor — e.g., one declared as adoption-phase
 * that emits a ViewEffect — slips past the manifest validator. The throw
 * surfaces such a bug at the boundary rather than silently dropping the
 * view payload.
 *
 * Phase 7b/8 wires the view-effect delivery surface (CLI stdout, MCP
 * response, HTTP stream).
 */
const captureViewPlaceholder: ApplyEffectSinks["captureView"] = async () => {
  throw new Error(
    "submitProposal: captureView not yet wired — Phase 7b/8 will inject the view-effect delivery surface.",
  );
};
