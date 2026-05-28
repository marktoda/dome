// Shared routing for garden-phase PatchEffects.
//
// Garden patches are special: unlike adoption-phase patches, they do not
// mutate the current candidate through the generic applyEffect patch sink.
// An authorized auto-mode garden patch is eligible to spawn a sub-Proposal;
// denied/downgraded patches surface broker diagnostics; propose-mode patches
// are diagnosed and dropped until the review surface exists.

import {
  diagnosticEffect,
  type DiagnosticEffect,
  type PatchEffect,
} from "../core/effect";
import type { Capability } from "../core/processor";
import type { ApplyEffectSinks } from "./apply-effect";
import { enforceCapability } from "./capability-broker";
import {
  capabilityUseForPatch,
  type EffectCapabilityUse,
} from "./effect-capability-use";
import type { RunId } from "./runner-contract";

const EMPTY_DIAGNOSTICS = Object.freeze([]) as ReadonlyArray<DiagnosticEffect>;

export type GardenPatchRoute =
  | {
      readonly kind: "spawn";
      readonly patch: PatchEffect;
      readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
      readonly capabilityUse: EffectCapabilityUse;
      readonly rejected: false;
    }
  | {
      readonly kind: "dropped";
      readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
      readonly capabilityUse?: EffectCapabilityUse;
      readonly rejected: boolean;
    };

export async function routeGardenPatchForSubProposal(opts: {
  readonly effect: PatchEffect;
  readonly processorId: string;
  readonly runId: RunId;
  readonly proposalId: string | null;
  readonly declared: ReadonlyArray<Capability>;
  readonly granted: ReadonlyArray<Capability>;
  readonly sinks: ApplyEffectSinks;
}): Promise<GardenPatchRoute> {
  const verdict = enforceCapability(opts.effect, opts.declared, opts.granted);

  if (verdict.kind === "deny") {
    await opts.sinks.recordDiagnostic({
      effect: verdict.diagnostic,
      processorId: opts.processorId,
      runId: opts.runId,
      proposalId: opts.proposalId,
    });
    return Object.freeze({
      kind: "dropped",
      diagnostics: Object.freeze([verdict.diagnostic]),
      capabilityUse: capabilityUseForPatch(opts.effect, "denied"),
      rejected: true,
    });
  }

  if (verdict.kind === "downgrade") {
    await opts.sinks.recordDiagnostic({
      effect: verdict.diagnostic,
      processorId: opts.processorId,
      runId: opts.runId,
      proposalId: opts.proposalId,
    });
    return Object.freeze({
      kind: "dropped",
      diagnostics: Object.freeze([verdict.diagnostic]),
      capabilityUse: capabilityUseForPatch(opts.effect, "downgraded"),
      rejected: false,
    });
  }

  if (opts.effect.mode !== "auto") {
    const diagnostic = diagnosticEffect({
      severity: "info",
      code: "garden.patch-propose-review-unavailable",
      message:
        `Garden PatchEffect from ${opts.processorId} requested review, ` +
        `but the garden propose review surface is not wired in v1.0; ` +
        `patch dropped: ${opts.effect.reason}`,
      sourceRefs: opts.effect.sourceRefs,
    });
    await opts.sinks.recordDiagnostic({
      effect: diagnostic,
      processorId: opts.processorId,
      runId: opts.runId,
      proposalId: opts.proposalId,
    });
    return Object.freeze({
      kind: "dropped",
      diagnostics: Object.freeze([diagnostic]),
      capabilityUse: capabilityUseForPatch(opts.effect, "allowed"),
      rejected: false,
    });
  }

  return Object.freeze({
    kind: "spawn",
    patch: opts.effect,
    diagnostics: EMPTY_DIAGNOSTICS,
    capabilityUse: capabilityUseForPatch(opts.effect, "allowed"),
    rejected: false,
  });
}
