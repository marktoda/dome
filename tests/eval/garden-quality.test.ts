import { describe, expect, test } from "bun:test";
import { fileChange } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { compileGardenQuality } from "../../src/eval/garden-quality";
import type { CapabilityUseRow } from "../../src/ledger/capability-uses";
import type { RunId, RunRow } from "../../src/ledger/runs";
import type { PendingProposalRow } from "../../src/proposals/pending-proposals";

const COMMIT = commitOid("b".repeat(40));

function proposal(
  overrides: Partial<PendingProposalRow> & Pick<PendingProposalRow, "id">,
): PendingProposalRow {
  const { id, ...rest } = overrides;
  const hash = id.toString(16).padStart(12, "0");
  return {
    id,
    dedupeKey: `key-${id}`,
    processorId: "dome.agent.garden",
    extensionId: "dome.agent",
    runId: null,
    reason: `dome.agent.garden opportunity orphan-page:${hash}`,
    changes: [fileChange({ kind: "write", path: "wiki/a.md", content: "one\ntwo\n" })],
    sourceRefs: [sourceRef({ commit: COMMIT, path: "wiki/a.md" })],
    baseCommit: COMMIT,
    baseContents: { "wiki/a.md": "one\n" },
    createdAt: "2026-07-10T00:00:00.000Z",
    status: "pending",
    decidedAt: null,
    decidedBy: null,
    appliedCommit: null,
    note: null,
    ...rest,
  };
}

function run(id: string, overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: id as RunId,
    proposalId: null,
    processorId: "dome.agent.garden",
    processorVersion: "1.0.0",
    phase: "garden",
    inputCommit: COMMIT,
    outputCommit: null,
    status: "succeeded",
    effectHashes: [],
    costUsd: null,
    durationMs: null,
    error: null,
    triggerKind: "schedule",
    triggerPayload: null,
    startedAt: "2026-07-10T00:00:00.000Z",
    finishedAt: "2026-07-10T00:01:00.000Z",
    ...overrides,
  };
}

function use(runId: string, capability: string, id: number): CapabilityUseRow {
  return {
    id,
    runId: runId as RunId,
    capability,
    resource: null,
    outcome: "allowed",
    recordedAt: "2026-07-10T00:00:00.000Z",
  };
}

describe("garden outcome compiler", () => {
  test("reports the execution-to-decision funnel without inferring quality", () => {
    const report = compileGardenQuality({
      currentOpportunityCount: 59,
      runs: [
        run("run-linked", { effectHashes: ["effect-a"], costUsd: 1.25, durationMs: 1000 }),
        run("run-unlinked", { effectHashes: ["effect-b"], costUsd: 0.75, durationMs: 3000 }),
        run("run-zero"),
        run("run-failed", { status: "failed", durationMs: 500 }),
        run("run-other", { processorId: "other.garden", effectHashes: ["ignored"] }),
      ],
      capabilityUsesByRun: [
        { runId: "run-linked", uses: [use("run-linked", "model.invoke", 1), use("run-linked", "patch.propose", 2)] },
        { runId: "run-unlinked", uses: [use("run-unlinked", "model.invoke", 3)] },
        { runId: "run-zero", uses: [] },
      ],
      proposals: [
        proposal({ id: 1, runId: "run-linked", status: "applied", decidedBy: "owner", decidedAt: "2026-07-10T02:00:00.000Z" }),
        proposal({ id: 2, status: "rejected", decidedBy: "owner", decidedAt: "2026-07-10T04:00:00.000Z" }),
        proposal({ id: 3 }),
        proposal({ id: 4, status: "rejected", decidedBy: "expired", decidedAt: "2026-07-10T01:00:00.000Z" }),
        proposal({ id: 5, processorId: "another.garden" }),
      ],
    });
    expect(report).toMatchObject({
      schema: "dome.eval.garden/v2",
      opportunities: { current: 59 },
      runs: {
        total: 4,
        byStatus: { succeeded: 3, failed: 1 },
        costed: 2,
        totalCostUsd: 2,
        meanCostUsd: 1,
        timed: 3,
        totalDurationMs: 4500,
        meanDurationMs: 1500,
        modelInvokeCount: 2,
        succeededZeroEffects: 1,
        effectful: 2,
      },
      linkage: {
        runsWithLinkedProposal: 1,
        effectfulWithoutLinkedProposal: 1,
        linkedRate: 0.5,
        proposalsWithoutRetainedRun: 3,
        patchProposeAttempts: 1,
      },
      proposals: {
        proposed: 4,
        pending: 1,
        humanDecided: 2,
        applied: 1,
        ownerRejected: 1,
        expired: 1,
        ownerApplyRate: 0.5,
        medianDecisionHours: 3,
        editSize: { meanFiles: 1, meanAddedLines: 1, meanRemovedLines: 0 },
        changedEvidenceRecurrence: { subjects: 1, recurringSubjects: 1, rate: 1 },
      },
    });
    expect(report.proposals.byKind["orphan-page"]).toEqual({
      proposed: 4, applied: 1, ownerRejected: 1, pending: 1,
    });
  });

  test("zero sample uses null ratios and absent-evidence metrics", () => {
    expect(compileGardenQuality({
      proposals: [], runs: [], capabilityUsesByRun: [],
    })).toMatchObject({
      opportunities: { current: null },
      runs: {
        total: 0,
        totalCostUsd: null,
        meanCostUsd: null,
        totalDurationMs: null,
        meanDurationMs: null,
        modelInvokeCount: 0,
        succeededZeroEffects: 0,
      },
      linkage: {
        linkedRate: null,
        patchProposeAttempts: null,
      },
      proposals: {
        proposed: 0,
        ownerApplyRate: null,
        medianDecisionHours: null,
        editSize: { meanFiles: null, meanAddedLines: null, meanRemovedLines: null },
        changedEvidenceRecurrence: { subjects: 0, recurringSubjects: 0, rate: null },
      },
    });
  });

  test("a malformed proposal reason cannot create proposal linkage", () => {
    const report = compileGardenQuality({
      proposals: [proposal({ id: 1, reason: "manual cleanup", runId: "run-effectful" })],
      runs: [run("run-effectful", { effectHashes: ["effect"] })],
      capabilityUsesByRun: [],
    });
    expect(report.proposals.proposed).toBe(0);
    expect(report.linkage.runsWithLinkedProposal).toBe(0);
    expect(report.linkage.effectfulWithoutLinkedProposal).toBe(1);
    expect(report.linkage.proposalsWithoutRetainedRun).toBe(0);
  });
});
