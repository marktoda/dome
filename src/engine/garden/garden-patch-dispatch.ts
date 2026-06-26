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
} from "../../core/effect";
import type { Capability } from "../../core/processor";
import type { CommitOid } from "../../core/source-ref";
import type { LedgerDb } from "../../ledger/db";
import { applyEffect, type ApplyEffectSinks } from "../core/apply-effect";
import type { ApplyPatchInput } from "../core/apply-patch";
import { recordEffectCapabilityUse } from "../core/effect-capability-use";
import { resolveCurrentAdopted } from "../core/adoption-status";
import {
  spawnGardenSubProposal,
  DEFAULT_MAX_CASCADE_DEPTH,
  type AdoptSubProposalFn,
} from "./garden-sub-proposals";
import type { RunId } from "../core/runner-contract";
import type { EngineVault } from "../core/vault-shape";

export type GardenPatchDispatchResult = {
  readonly authorized: boolean;
  readonly spawned: boolean;
  readonly rejected: boolean;
};

export async function dispatchGardenPatchEffect(opts: {
  readonly effect: PatchEffect;
  readonly vault: EngineVault;
  readonly adopted: CommitOid;
  readonly currentAdopted?: () => CommitOid;
  readonly processorId: string;
  readonly runId: RunId;
  readonly proposalId: string | null;
  readonly declared: ReadonlyArray<Capability>;
  readonly granted: ReadonlyArray<Capability>;
  readonly sinks: ApplyEffectSinks;
  readonly ledger?: LedgerDb;
  readonly diagnostics: DiagnosticEffect[];
  readonly adoptSubProposal?: AdoptSubProposalFn;
  readonly applyGardenPatch: (opts: ApplyPatchInput) => Promise<CommitOid | null>;
  readonly extensionId: string;
  readonly disabledDiagnostic: {
    readonly code: string;
    readonly message: string;
  };
  /**
   * The cascade depth of the CURRENT orchestrator run (the parent depth). For a
   * top-level operational run (scheduler/jobs/answers) this is 0; the spawned
   * sub-Proposal adoption runs at depth 1. Defaults to 0 when omitted (matches
   * the top-level default of the signal path in garden.ts).
   */
  readonly cascadeDepth?: number;
  /**
   * Cap on cascade recursion. Defaults to DEFAULT_MAX_CASCADE_DEPTH (10).
   * Forwarded to spawnGardenSubProposal where the cap is enforced.
   */
  readonly maxCascadeDepth?: number;
  readonly now?: () => Date;
}): Promise<GardenPatchDispatchResult> {
  const applied = await applyEffect({
    effect: opts.effect,
    processorId: opts.processorId,
    runId: opts.runId,
    proposalId: opts.proposalId,
    phase: "garden",
    declared: opts.declared,
    granted: opts.granted,
    sinks: opts.sinks,
    // Garden patches never write through the patch sink, so the candidate OID
    // is unused on this path; pass the adopted commit for completeness.
    candidate: opts.adopted,
  });
  recordEffectCapabilityUse({
    ledger: opts.ledger,
    runId: opts.runId,
    ...(applied.capabilityUse !== undefined
      ? { capabilityUse: applied.capabilityUse }
      : {}),
  });
  opts.diagnostics.push(...applied.diagnostics);
  if (applied.outcome !== "queued-for-spawn") {
    return Object.freeze({
      authorized: false,
      spawned: false,
      rejected: applied.outcome === "denied",
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

  const adopted = resolveCurrentAdopted(opts.currentAdopted, opts.adopted);
  const mergeConflicts: Array<{ path: string; processorId: string }> = [];
  // cascadeDepth is the PARENT depth (0 for a top-level operational run).
  // spawnGardenSubProposal enforces the cap and adopts at cascadeDepth + 1.
  const cascadeDepth = opts.cascadeDepth ?? 0;
  const maxCascadeDepth = opts.maxCascadeDepth ?? DEFAULT_MAX_CASCADE_DEPTH;
  const spawned = await spawnGardenSubProposal({
    vault: opts.vault,
    base: adopted,
    mergeBase: opts.adopted,
    sourceHead: adopted,
    patch: opts.effect,
    processorId: opts.processorId,
    runId: opts.runId,
    extensionId: opts.extensionId,
    cascadeDepth,
    maxCascadeDepth,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    applyPatch: opts.applyGardenPatch,
    adoptSubProposal: opts.adoptSubProposal,
    onMergeConflict: (info) => mergeConflicts.push(info),
  });
  if (spawned.kind === "cascade-capped") {
    opts.diagnostics.push(spawned.diagnostic);
    await opts.sinks.recordDiagnostic({
      effect: spawned.diagnostic,
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
  // A true 3-way merge conflict resolves to the already-landed content; surface
  // it so the silent resolve-to-ours is operator-visible.
  for (const conflict of mergeConflicts) {
    const diag = diagnosticEffect({
      severity: "warning",
      code: "garden.patch.merge-conflict",
      message:
        `Garden patch from ${conflict.processorId} conflicted with a ` +
        `concurrently-landed change at ${conflict.path}; resolved to the ` +
        `already-landed content (the conflicting region was not applied).`,
      sourceRefs: [],
    });
    opts.diagnostics.push(diag);
    await opts.sinks.recordDiagnostic({
      effect: diag,
      processorId: conflict.processorId,
      runId: opts.runId,
      proposalId: opts.proposalId,
    });
  }
  return Object.freeze({
    authorized: true,
    spawned: spawned.kind === "spawned",
    rejected: false,
  });
}
