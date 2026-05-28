// Shared garden PatchEffect -> sub-Proposal conversion.
//
// Garden-originated patches are not applied inline through the generic
// adoption candidate sink. Once the broker authorizes an auto-mode garden
// PatchEffect, the engine applies it against the adopted commit, wraps the
// resulting head in a garden-source Proposal, and re-enters adoption through
// the caller's `adoptSubProposal` boundary.

import type { PatchEffect } from "../core/effect";
import {
  makeGardenProposal,
  proposalMetadata,
  type AdoptionResult,
  type Proposal,
} from "../core/proposal";
import type { CommitOid } from "../core/source-ref";
import type { RunId } from "./runner-contract";
import type { EngineVault } from "./vault-shape";
import type { ApplyPatchInput } from "./apply-patch";

export type AdoptGardenSubProposalFn = (
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
  readonly sourceHead: CommitOid;
  readonly patch: PatchEffect;
  readonly processorId: string;
  readonly runId: RunId;
  readonly extensionId: string;
  readonly cascadeDepth: number;
  readonly applyPatch: (opts: ApplyPatchInput) => Promise<CommitOid | null>;
  readonly adoptSubProposal: AdoptGardenSubProposalFn;
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
      sourceHead: opts.sourceHead,
    },
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
