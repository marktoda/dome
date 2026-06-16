// Shared garden PatchEffect -> sub-Proposal conversion.
//
// Garden-originated patches are not applied inline through the generic
// adoption candidate sink. Once the broker authorizes an auto-mode garden
// PatchEffect, the engine applies it against the adopted commit, wraps the
// resulting head in a garden-source Proposal, and re-enters adoption through
// the caller's `adoptSubProposal` boundary.

import type { PatchEffect } from "../../core/effect";
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
  readonly cascadeDepth: number;
  readonly now?: () => Date;
  readonly applyPatch: (opts: ApplyPatchInput) => Promise<CommitOid | null>;
  readonly adoptSubProposal: AdoptSubProposalFn;
}): Promise<GardenSubProposalSpawnResult> {
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
  const adoption = await opts.adoptSubProposal(proposal, opts.cascadeDepth);
  return Object.freeze({
    kind: "spawned" as const,
    proposal,
    adoption,
  });
}
