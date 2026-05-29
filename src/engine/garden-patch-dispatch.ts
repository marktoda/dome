// Shared garden PatchEffect dispatch for non-signal garden sources.
//
// Scheduled processors, queued jobs, and answer handlers all run against the
// adopted snapshot outside the main signal-triggered garden orchestrator. When
// they emit a garden PatchEffect, the effect still follows the same path:
// broker route, capability-use ledger row, optional disabled-spawn diagnostic,
// then sub-Proposal adoption.

import {
  diagnosticEffect,
  type DiagnosticEffect,
  type PatchEffect,
} from "../core/effect";
import type { Capability } from "../core/processor";
import type { CommitOid } from "../core/source-ref";
import type { LedgerDb } from "../ledger/db";
import type { ApplyEffectSinks } from "./apply-effect";
import type { ApplyPatchInput } from "./apply-patch";
import { recordEffectCapabilityUse } from "./effect-capability-use";
import { routeGardenPatchForSubProposal } from "./garden-patch-router";
import {
  spawnGardenSubProposal,
  type AdoptGardenSubProposalFn,
} from "./garden-sub-proposals";
import type { RunId } from "./runner-contract";
import type { EngineVault } from "./vault-shape";

export type GardenPatchDispatchResult = {
  readonly authorized: boolean;
  readonly spawned: boolean;
  readonly rejected: boolean;
};

export async function dispatchGardenPatchEffect(opts: {
  readonly effect: PatchEffect;
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly processorId: string;
  readonly runId: RunId;
  readonly proposalId: string | null;
  readonly declared: ReadonlyArray<Capability>;
  readonly granted: ReadonlyArray<Capability>;
  readonly sinks: ApplyEffectSinks;
  readonly ledger?: LedgerDb;
  readonly diagnostics: DiagnosticEffect[];
  readonly adoptSubProposal?: AdoptGardenSubProposalFn;
  readonly applyGardenPatch: (opts: ApplyPatchInput) => Promise<CommitOid | null>;
  readonly extensionId: string;
  readonly disabledDiagnostic: {
    readonly code: string;
    readonly message: string;
  };
  readonly cascadeDepth?: number;
}): Promise<GardenPatchDispatchResult> {
  const routed = await routeGardenPatchForSubProposal({
    effect: opts.effect,
    processorId: opts.processorId,
    runId: opts.runId,
    proposalId: opts.proposalId,
    declared: opts.declared,
    granted: opts.granted,
    sinks: opts.sinks,
  });
  recordEffectCapabilityUse({
    ledger: opts.ledger,
    runId: opts.runId,
    ...(routed.capabilityUse !== undefined
      ? { capabilityUse: routed.capabilityUse }
      : {}),
  });
  opts.diagnostics.push(...routed.diagnostics);
  if (routed.kind === "dropped") {
    return Object.freeze({
      authorized: false,
      spawned: false,
      rejected: routed.rejected,
    });
  }

  if (opts.adoptSubProposal === undefined) {
    const drop = diagnosticEffect({
      severity: "info",
      code: opts.disabledDiagnostic.code,
      message: opts.disabledDiagnostic.message,
      sourceRefs: [],
    });
    opts.diagnostics.push(drop);
    await opts.sinks.recordDiagnostic({
      effect: drop,
      processorId: opts.processorId,
      runId: opts.runId,
      proposalId: opts.proposalId,
    });
    return Object.freeze({
      authorized: true,
      spawned: false,
      rejected: false,
    });
  }

  const spawned = await spawnGardenSubProposal({
    vault: opts.vault,
    base: opts.adopted,
    sourceHead: opts.adopted,
    patch: routed.patch,
    processorId: opts.processorId,
    runId: opts.runId,
    extensionId: opts.extensionId,
    cascadeDepth: opts.cascadeDepth ?? 1,
    applyPatch: opts.applyGardenPatch,
    adoptSubProposal: opts.adoptSubProposal,
  });
  return Object.freeze({
    authorized: true,
    spawned: spawned.kind === "spawned",
    rejected: false,
  });
}
