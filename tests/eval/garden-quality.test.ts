import { describe, expect, test } from "bun:test";
import { fileChange } from "../../src/core/effect";
import { commitOid, sourceRef } from "../../src/core/source-ref";
import { compileGardenQuality } from "../../src/eval/garden-quality";
import type { PendingProposalRow } from "../../src/proposals/pending-proposals";

const COMMIT = commitOid("b".repeat(40));

function row(overrides: Partial<PendingProposalRow> & Pick<PendingProposalRow, "id">): PendingProposalRow {
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

describe("garden outcome compiler", () => {
  test("reports owner outcomes, latency, edit size, and changed-evidence recurrence", () => {
    const report = compileGardenQuality([
      row({ id: 1, status: "applied", decidedBy: "owner", decidedAt: "2026-07-10T02:00:00.000Z" }),
      row({ id: 2, status: "rejected", decidedBy: "owner", decidedAt: "2026-07-10T04:00:00.000Z" }),
      row({ id: 3 }),
      row({ id: 4, status: "rejected", decidedBy: "expired", decidedAt: "2026-07-10T01:00:00.000Z" }),
      row({ id: 5, processorId: "another.garden" }),
    ]);
    expect(report).toMatchObject({
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
    });
    expect(report.byKind["orphan-page"]).toEqual({ proposed: 4, applied: 1, ownerRejected: 1, pending: 1 });
  });

  test("zero sample uses null rates instead of claiming success", () => {
    expect(compileGardenQuality([])).toMatchObject({
      proposed: 0,
      ownerApplyRate: null,
      medianDecisionHours: null,
      editSize: { meanFiles: null, meanAddedLines: null, meanRemovedLines: null },
      changedEvidenceRecurrence: { subjects: 0, recurringSubjects: 0, rate: null },
    });
  });

  test("ignores semantic-garden rows without a parseable opportunity identity", () => {
    expect(compileGardenQuality([row({ id: 1, reason: "manual cleanup" })]).proposed).toBe(0);
  });
});
