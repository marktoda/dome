// Canonical run-ledger audit labels for effect capability enforcement.
//
// The broker decides whether an effect is allowed, downgraded, or denied.
// This module translates that decision into the durable `capability_uses`
// row shape so adoption, garden, scheduler, and view commands do not each
// hand-roll slightly different audit labels.

import type { Effect, PatchEffect } from "../../core/effect";
import { recordCapabilityUse } from "../../ledger/capability-uses";
import type { LedgerDb } from "../../ledger/db";
import type { RunId } from "./runner-contract";

export type CapabilityUseOutcome = "allowed" | "downgraded" | "denied";

export type EffectCapabilityUse = {
  readonly capability: string;
  readonly resource: string | null;
  readonly outcome: CapabilityUseOutcome;
};

export function capabilityUseForEffect(
  effect: Effect,
  outcome: CapabilityUseOutcome,
): EffectCapabilityUse | null {
  switch (effect.kind) {
    case "patch":
      return capabilityUseForPatch(effect, outcome);
    case "fact": {
      const resource = predicateNamespace(effect.predicate);
      return Object.freeze({
        capability: "graph.write",
        resource,
        outcome,
      });
    }
    case "search-document":
      return Object.freeze({
        capability: "search.write",
        resource: effect.path,
        outcome,
      });
    case "question":
      return Object.freeze({
        capability: "question.ask",
        resource: null,
        outcome,
      });
    case "external":
      return Object.freeze({
        capability: `external:${effect.capability}`,
        resource: effect.capability,
        outcome,
      });
    case "outbox-recovery":
      return Object.freeze({
        capability: "outbox.recover",
        resource: `${effect.action}:${effect.idempotencyKey}`,
        outcome,
      });
    case "quarantine-recovery":
      return Object.freeze({
        capability: "quarantine.recover",
        resource:
          `${effect.action}:${effect.phase}:` +
          `${effect.processorId}:${effect.processorVersion}:` +
          `${effect.triggerHash}:` +
          `${effect.quarantineId}:` +
          `${effect.quarantinedAt}:` +
          `${effect.consecutiveRetryableFailures}`,
        outcome,
      });
    case "run-recovery":
      return Object.freeze({
        capability: "run.recover",
        resource:
          `${effect.action}:${effect.runId}:` +
          `${effect.startedAt}:${effect.processorId}:` +
          `${effect.processorVersion}:${effect.phase}`,
        outcome,
      });
    case "diagnostic":
    case "view":
      return null;
  }
  const _exhaustive: never = effect;
  return _exhaustive;
}

export function capabilityUseForPatch(
  effect: PatchEffect,
  outcome: CapabilityUseOutcome,
): EffectCapabilityUse {
  return Object.freeze({
    capability: effect.mode === "auto" ? "patch.auto" : "patch.propose",
    resource: patchResource(effect),
    outcome,
  });
}

function patchResource(effect: PatchEffect): string | null {
  const paths = [...new Set(effect.changes.map((change) => change.path))];
  if (paths.length === 0) return null;
  return paths.join(",");
}

export function recordEffectCapabilityUse(opts: {
  readonly ledger: LedgerDb;
  readonly runId: RunId;
  readonly capabilityUse?: EffectCapabilityUse | undefined;
  readonly recordedAt?: Date;
}): void {
  if (opts.capabilityUse === undefined) return;
  recordCapabilityUse(opts.ledger, {
    runId: opts.runId,
    capability: opts.capabilityUse.capability,
    resource: opts.capabilityUse.resource,
    outcome: opts.capabilityUse.outcome,
    recordedAt: opts.recordedAt ?? new Date(),
  });
}

/**
 * Extract the namespace prefix of a predicate. The predicate is
 * `<namespace>.<key>` per capabilities.md §"graph.write"; the namespace is
 * everything before the *last* `.`. Returns `null` for a predicate with no
 * dot (no namespace). Shared with the capability broker (same core layer).
 */
export function predicateNamespace(predicate: string): string | null {
  const lastDot = predicate.lastIndexOf(".");
  if (lastDot <= 0) return null;
  return predicate.slice(0, lastDot);
}
