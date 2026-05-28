// Shared routing for garden-phase PatchEffects.
//
// Garden patches are special: unlike adoption-phase patches, they do not
// mutate the current candidate through the generic applyEffect patch sink.
// An authorized auto-mode garden patch is eligible to spawn a sub-Proposal;
// denied/downgraded patches surface broker diagnostics; propose-mode patches
// are intentionally dropped until the review surface exists.

import type { DiagnosticEffect, PatchEffect } from "../core/effect";
import type { Capability } from "../core/processor";
import { recordCapabilityUse } from "../ledger/capability-uses";
import type { LedgerDb } from "../ledger/db";
import type { ApplyEffectSinks } from "./apply-effect";
import { enforceCapability } from "./capability-broker";
import type { RunId } from "./runner-contract";

const EMPTY_DIAGNOSTICS = Object.freeze([]) as ReadonlyArray<DiagnosticEffect>;

export type GardenPatchRoute =
  | {
      readonly kind: "spawn";
      readonly patch: PatchEffect;
      readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
      readonly rejected: false;
    }
  | {
      readonly kind: "dropped";
      readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
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
  readonly ledger?: LedgerDb;
}): Promise<GardenPatchRoute> {
  const verdict = enforceCapability(opts.effect, opts.declared, opts.granted);

  if (verdict.kind === "deny") {
    recordPatchCapabilityUse(opts, "denied");
    await opts.sinks.recordDiagnostic({
      effect: verdict.diagnostic,
      processorId: opts.processorId,
      runId: opts.runId,
      proposalId: opts.proposalId,
    });
    return Object.freeze({
      kind: "dropped",
      diagnostics: Object.freeze([verdict.diagnostic]),
      rejected: true,
    });
  }

  if (verdict.kind === "downgrade") {
    recordPatchCapabilityUse(opts, "downgraded");
    await opts.sinks.recordDiagnostic({
      effect: verdict.diagnostic,
      processorId: opts.processorId,
      runId: opts.runId,
      proposalId: opts.proposalId,
    });
    return Object.freeze({
      kind: "dropped",
      diagnostics: Object.freeze([verdict.diagnostic]),
      rejected: false,
    });
  }

  if (opts.effect.mode !== "auto") {
    return Object.freeze({
      kind: "dropped",
      diagnostics: EMPTY_DIAGNOSTICS,
      rejected: false,
    });
  }

  recordPatchCapabilityUse(opts, "allowed");
  return Object.freeze({
    kind: "spawn",
    patch: opts.effect,
    diagnostics: EMPTY_DIAGNOSTICS,
    rejected: false,
  });
}

function recordPatchCapabilityUse(
  opts: {
    readonly effect: PatchEffect;
    readonly runId: RunId;
    readonly ledger?: LedgerDb;
  },
  outcome: "allowed" | "downgraded" | "denied",
): void {
  if (opts.ledger === undefined) return;
  recordCapabilityUse(opts.ledger, {
    runId: opts.runId,
    capability: capabilityForPatch(opts.effect),
    resource: firstPatchedPath(opts.effect),
    outcome,
    recordedAt: new Date(),
  });
}

function capabilityForPatch(effect: PatchEffect): string {
  return effect.mode === "auto" ? "patch.auto" : "patch.propose";
}

function firstPatchedPath(effect: PatchEffect): string | null {
  return effect.changes[0]?.path ?? null;
}
