// Shared garden PatchEffect -> sub-Proposal conversion.
//
// Garden-originated patches are not applied inline through the generic
// adoption candidate sink. Once the broker authorizes an auto-mode garden
// PatchEffect, the engine applies it against the adopted commit, wraps the
// resulting head in a garden-source Proposal, and re-enters adoption through
// the caller's `adoptSubProposal` boundary.
//
// Cascade-cap enforcement: all four sources (signal via garden.ts, scheduler,
// queued jobs, answer handlers) funnel through `spawnGardenSubProposal`. The
// cap check lives here so every source is equally bounded — not just the
// signal path.

import type { DiagnosticEffect, PatchEffect } from "../../core/effect";
import { diagnosticEffect } from "../../core/effect";
import {
  makeGardenProposal,
  proposalMetadata,
  type AdoptionResult,
  type Proposal,
} from "../../core/proposal";
import type { CommitOid } from "../../core/source-ref";
import type { RunId } from "../core/runner-contract";
import type { EngineVault } from "../core/vault-shape";
import type { ApplyPatchInput } from "../core/apply-patch";

// ----- DEFAULT_MAX_CASCADE_DEPTH --------------------------------------------

/**
 * The default cap on garden → sub-Proposal recursion depth. A garden
 * processor that emits a PatchEffect spawns a sub-Proposal; if THAT
 * adoption's garden phase emits another PatchEffect, depth is 2; and
 * so on. The cap prevents unbounded recursion when garden processors
 * react to each other in cycles.
 *
 * The default of 10 is generous; legitimate cascades (entity created →
 * backlinks added → search-index updated) usually reach depth 2-3.
 * Hitting the cap surfaces a `garden.cascade-cap` DiagnosticEffect;
 * the cap can be raised per-call via `maxCascadeDepth`.
 *
 * Mirrors the philosophy of `DEFAULT_MAX_ITERATIONS` in adopt.ts —
 * generous default, explicit override, structural fence against
 * pathological cycles.
 *
 * Lives here (the chokepoint) rather than garden.ts so every source that
 * calls spawnGardenSubProposal can import the default without pulling in
 * the full orchestrator.
 */
export const DEFAULT_MAX_CASCADE_DEPTH = 10;

/**
 * Re-enter adoption for a garden-spawned sub-Proposal at the given cascade
 * depth. The single canonical sub-Proposal adoption boundary, shared by the
 * garden orchestrator, run routing, patch dispatch, and the compiler host.
 */
export type AdoptSubProposalFn = (
  proposal: Proposal,
  cascadeDepth: number,
) => Promise<AdoptionResult>;

export type GardenSubProposalSpawnResult =
  | {
      readonly kind: "spawned";
      readonly proposal: Proposal;
      readonly adoption: AdoptionResult;
    }
  | {
      readonly kind: "dropped";
      readonly reason: "patch-not-applied";
    }
  | {
      /**
       * Cascade depth cap was hit: `cascadeDepth >= maxCascadeDepth`. No patch
       * was applied and no sub-Proposal was spawned. The diagnostic is
       * pre-built (same code/severity/message as the former inline cap arm in
       * garden.ts) so the caller can record it via the appropriate sink without
       * re-deriving the message.
       */
      readonly kind: "cascade-capped";
      readonly diagnostic: DiagnosticEffect;
    };

export async function spawnGardenSubProposal(opts: {
  readonly vault: EngineVault;
  readonly base: CommitOid;
  /**
   * The snapshot the emitting processor READ — the 3-way merge base for the
   * patch's whole-file write. Distinct from `base` (which is the live candidate
   * / proposal base / Dome-Base trailer). When it equals `base` (nothing landed
   * since the read) apply-patch overwrites as before; when a sibling advanced
   * `base` past it, apply-patch merges. See
   * docs/cohesive/brainstorms/2026-06-16-garden-patch-3way-merge.md.
   */
  readonly mergeBase: CommitOid;
  readonly sourceHead: CommitOid;
  readonly patch: PatchEffect;
  readonly processorId: string;
  readonly runId: RunId;
  readonly extensionId: string;
  /**
   * The cascade depth of the CURRENT orchestrator run (the parent depth).
   * The sub-Proposal adoption is called at `cascadeDepth + 1`.
   *
   * - Signal path (garden.ts at depth 0): pass 0 → adoptSubProposal gets 1.
   * - Operational sources (scheduler/jobs/answers at top level): pass 0 →
   *   adoptSubProposal gets 1.
   *
   * The cap check `cascadeDepth >= maxCascadeDepth` fires at the parent
   * depth, matching the former inline arm in garden.ts — so the signal
   * path's bound is unchanged and operational sources now get the same bound.
   */
  readonly cascadeDepth: number;
  /**
   * The maximum allowed cascade depth. Must be explicit at every call site
   * so the cap is always visible. Use `DEFAULT_MAX_CASCADE_DEPTH` (10) for
   * non-override callers.
   */
  readonly maxCascadeDepth: number;
  readonly now?: () => Date;
  /** Forwarded to applyPatch; fires per write whose 3-way merge truly conflicted (resolved to `ours`). */
  readonly onMergeConflict?: (info: { readonly path: string; readonly processorId: string }) => void;
  readonly applyPatch: (opts: ApplyPatchInput) => Promise<CommitOid | null>;
  readonly adoptSubProposal: AdoptSubProposalFn;
}): Promise<GardenSubProposalSpawnResult> {
  // Cascade-cap enforcement: all sources funnel through this single
  // conversion boundary. The cap-firing DEPTH (`cascadeDepth >= maxCascadeDepth`,
  // parent-depth semantics) matches the former inline arm in garden.ts, so the
  // signal path's bound is unchanged and operational sources now get the same
  // bound. NOTE: the diagnostic message built here is the per-patch operational
  // form ("1 PatchEffect(s)"); the signal path re-aggregates capped results in
  // garden.ts to preserve its original batched "N PatchEffect(s)" message.
  if (opts.cascadeDepth >= opts.maxCascadeDepth) {
    const capDiag = diagnosticEffect({
      severity: "warning",
      code: "garden.cascade-cap",
      message:
        `Garden sub-Proposal cascade hit cap=${opts.maxCascadeDepth} at ` +
        `depth=${opts.cascadeDepth}; 1 PatchEffect(s) ` +
        `skipped. Garden processors named: ${opts.processorId}.`,
      sourceRefs: [],
    });
    return Object.freeze({
      kind: "cascade-capped" as const,
      diagnostic: capDiag,
    });
  }

  const newHead = await opts.applyPatch({
    vaultPath: opts.vault.path,
    candidate: opts.base,
    patch: opts.patch,
    runContext: {
      runId: opts.runId,
      processorId: opts.processorId,
      extensionId: opts.extensionId,
      base: opts.base,
      mergeBase: opts.mergeBase,
      sourceHead: opts.sourceHead,
    },
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.onMergeConflict !== undefined
      ? { onMergeConflict: opts.onMergeConflict }
      : {}),
  });
  if (newHead === null) {
    return Object.freeze({
      kind: "dropped" as const,
      reason: "patch-not-applied" as const,
    });
  }

  const proposal = makeGardenProposal({
    base: opts.base,
    head: newHead,
    processorId: opts.processorId,
    runId: opts.runId,
    metadata: proposalMetadata({ reason: opts.patch.reason }),
  });
  // adoptSubProposal receives the child depth (parent + 1) so the recursive
  // garden run starts at the correct depth.
  const adoption = await opts.adoptSubProposal(proposal, opts.cascadeDepth + 1);
  return Object.freeze({
    kind: "spawned" as const,
    proposal,
    adoption,
  });
}
