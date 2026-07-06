// engine/operational/proposal-expiry: auto-reject PENDING garden proposals
// whose owning processor no longer exists.
//
// A `pending_proposals` row (`proposals.db`, src/proposals/db.ts) is a garden
// processor's `mode: "propose"` PatchEffect, queued for the owner's `dome
// apply` / `dome proposals reject` decision. When the processor that
// proposed it retires (its bundle is uninstalled, or the processor is
// deleted from a still-installed bundle), the row can never be revisited by
// that processor and the owner review surface would otherwise carry it
// forever — a dead patch nobody asked for, against a base that may have
// long since drifted. This pump auto-rejects it, exactly mirroring
// `question-expiry.ts`'s subject-liveness rule for OPEN questions (see that
// module's header for the full rationale).
//
// Disabled-bundle exemption: identical posture to question expiry and the
// quarantine GC's `isKnownProcessorFor` (src/engine/host/vault-runtime.ts,
// main commit 28b912d3 "registry is authoritative for enabled bundles"). A
// configured-but-DISABLED bundle's processors are deliberately absent from
// the resolved registry, but the bundle is still installed — re-enabling it
// must find its pending proposals intact. A processor is RETIRED only when
// it is absent from the registry AND not covered by a disabled-extension
// prefix.
//
// Cheap and idempotent: only PENDING proposals are read each pass, and
// `decideProposal`'s CAS (`WHERE status = 'pending'`) means a row already
// decided by this pump (or by the owner, in a race) drops out of the pending
// set on the next pass.

import { diagnosticEffect, type DiagnosticEffect } from "../../core/effect";
import type { ApplyEffectSinks } from "../core/apply-effect";
import { recordDiagnosticsViaSink } from "../core/diagnostics";
import {
  decideProposal,
  listProposals,
  type PendingProposalRow,
} from "../../proposals/pending-proposals";
import type { ProposalsDb } from "../../proposals/db";
import type { ProcessorRegistry } from "../../processors/registry";

export type ProposalExpiryDeps = {
  /** Active processor ids — a pending proposal whose processor is absent expires. */
  readonly registry: ProcessorRegistry;
  /**
   * Extension ids configured but DISABLED (`ExtensionPolicyStatus.enabled ===
   * false`). Their processors are absent from the registry by design and are
   * EXEMPT from expiry — same threading as `QuestionExpiryDeps`. Empty array
   * → the registry is fully authoritative.
   */
  readonly disabledExtensionIds: ReadonlyArray<string>;
  /** The pending-proposals store accessor. */
  readonly proposals: ProposalsDb;
  readonly recordDiagnostic: ApplyEffectSinks["recordDiagnostic"];
  readonly now: () => Date;
};

export type ProposalExpiryResult = {
  readonly expired: number;
  /**
   * The expiry diagnostics, ALSO recorded through `recordDiagnostic` — the
   * question-expiry dual pattern, so `runOperationalWork` callers (sync
   * --json counts, serve lines) see them without re-reading the sink.
   */
  readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
};

const EXPIRY_PROCESSOR_ID = "engine.proposal-expiry";

/**
 * Reject every PENDING proposal whose owning `processor_id` is retired —
 * absent from the active registry and not exempted by a disabled-extension
 * prefix. Decides `{status: "rejected", decidedBy: "expired", note:
 * "processor retired"}` via the existing CAS `decideProposal`, and raises one
 * info diagnostic per expiry.
 */
export async function expireOrphanProposals(
  deps: ProposalExpiryDeps,
): Promise<ProposalExpiryResult> {
  const pending = listProposals(deps.proposals, { status: "pending" });

  let expired = 0;
  const diagnostics: DiagnosticEffect[] = [];
  for (const proposal of pending) {
    if (!isRetired(proposal.processorId, deps)) continue;

    const decidedAt = deps.now().toISOString();
    const decided = decideProposal(deps.proposals, {
      id: proposal.id,
      status: "rejected",
      decidedBy: "expired",
      note: "processor retired",
      decidedAt,
    });
    if (!decided) continue;

    const diagnostic = diagnosticOf(proposal);
    diagnostics.push(diagnostic);
    await recordDiagnosticsViaSink({
      sinks: { recordDiagnostic: deps.recordDiagnostic },
      diagnostics: [diagnostic],
      processorId: EXPIRY_PROCESSOR_ID,
      proposalId: null,
    });
    expired += 1;
  }

  return Object.freeze({
    expired,
    diagnostics: Object.freeze([...diagnostics]),
  });
}

function diagnosticOf(proposal: PendingProposalRow): DiagnosticEffect {
  return diagnosticEffect({
    severity: "info",
    code: "proposal.expired-subject-retired",
    message:
      `Proposal ${proposal.id} expired: processor ` +
      `${proposal.processorId} is retired.`,
    sourceRefs: proposal.sourceRefs,
  });
}

/**
 * Mirror of `question-expiry.ts`'s `isRetired` (byte-for-byte posture):
 * registered → live; unregistered but under a configured-but-disabled
 * bundle's prefix → live (exempt); otherwise retired. Processor ids are
 * bundle-namespaced (`<extensionId>.<name>`), matching that predicate's
 * prefix convention.
 */
function isRetired(
  processorId: string,
  deps: Pick<ProposalExpiryDeps, "registry" | "disabledExtensionIds">,
): boolean {
  if (deps.registry.get(processorId) !== undefined) return false;
  return !deps.disabledExtensionIds.some(
    (extensionId) =>
      processorId === extensionId ||
      processorId.startsWith(`${extensionId}.`),
  );
}
