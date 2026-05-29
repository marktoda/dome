// Shared effect routing for one non-signal garden processor run.
//
// Schedule fires, queued jobs, and answer handlers all dispatch exactly one
// garden-phase processor against the adopted snapshot. Their source-specific
// code decides when to run and what summary to record; this helper owns the
// common effect routing contract: PatchEffects go through garden sub-Proposal
// dispatch, while all other effects go through the generic effect applier.

import type { DiagnosticEffect } from "../core/effect";
import type { CommitOid } from "../core/source-ref";
import type { LedgerDb } from "../ledger/db";
import { applyEffect, type ApplyEffectSinks } from "./apply-effect";
import type { ApplyPatchInput } from "./apply-patch";
import { dispatchGardenPatchEffect } from "./garden-patch-dispatch";
import type { AdoptGardenSubProposalFn } from "./garden-sub-proposals";
import { recordEffectCapabilityUse } from "./effect-capability-use";
import type { RunnerResult } from "./runner-contract";
import type { EngineVault } from "./vault-shape";

export type GardenRunEffectRoutingSummary = {
  readonly authorizedPatchCount: number;
  readonly spawnedPatchCount: number;
  readonly rejectedPatchCount: number;
};

export async function routeGardenRunEffects(opts: {
  readonly result: RunnerResult;
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly currentAdopted?: () => CommitOid;
  readonly proposalId: string | null;
  readonly sinks: ApplyEffectSinks;
  readonly ledger?: LedgerDb;
  readonly diagnostics: DiagnosticEffect[];
  readonly applyGardenPatch: (
    opts: ApplyPatchInput,
  ) => Promise<CommitOid | null>;
  readonly extensionIdFor: (processorId: string) => string;
  readonly adoptSubProposal?: AdoptGardenSubProposalFn;
  readonly disabledDiagnostic: {
    readonly code: string;
    readonly message: string;
  };
  readonly cascadeDepth?: number;
  readonly now?: () => Date;
}): Promise<GardenRunEffectRoutingSummary> {
  let authorizedPatchCount = 0;
  let spawnedPatchCount = 0;
  let rejectedPatchCount = 0;

  for (const effect of opts.result.effects) {
    if (effect.kind === "patch") {
      const routed = await dispatchGardenPatchEffect({
        effect,
        vault: opts.vault,
        adopted: opts.adopted,
        ...(opts.currentAdopted !== undefined
          ? { currentAdopted: opts.currentAdopted }
          : {}),
        processorId: opts.result.processorId,
        runId: opts.result.runId,
        proposalId: opts.proposalId,
        declared: opts.result.declared,
        granted: opts.result.granted,
        sinks: opts.sinks,
        diagnostics: opts.diagnostics,
        applyGardenPatch: opts.applyGardenPatch,
        extensionId: opts.extensionIdFor(opts.result.processorId),
        ...(opts.ledger !== undefined ? { ledger: opts.ledger } : {}),
        ...(opts.adoptSubProposal !== undefined
          ? { adoptSubProposal: opts.adoptSubProposal }
          : {}),
        disabledDiagnostic: opts.disabledDiagnostic,
        ...(opts.cascadeDepth !== undefined
          ? { cascadeDepth: opts.cascadeDepth }
          : {}),
        ...(opts.now !== undefined ? { now: opts.now } : {}),
      });
      if (routed.authorized) authorizedPatchCount += 1;
      if (routed.spawned) spawnedPatchCount += 1;
      if (routed.rejected) rejectedPatchCount += 1;
      continue;
    }

    const applied = await applyEffect({
      effect,
      processorId: opts.result.processorId,
      runId: opts.result.runId,
      proposalId: opts.proposalId,
      phase: "garden",
      declared: opts.result.declared,
      granted: opts.result.granted,
      sinks: opts.sinks,
      candidate: opts.adopted,
    });
    if (applied.diagnostics.length > 0) {
      opts.diagnostics.push(...applied.diagnostics);
    }
    recordEffectCapabilityUse({
      ledger: opts.ledger,
      runId: opts.result.runId,
      ...(applied.capabilityUse !== undefined
        ? { capabilityUse: applied.capabilityUse }
        : {}),
    });
  }

  return Object.freeze({
    authorizedPatchCount,
    spawnedPatchCount,
    rejectedPatchCount,
  });
}
