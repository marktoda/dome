import { compareStrings } from "../core/compare";
import type { CapabilityUseRow } from "../ledger/capability-uses";
import type { RunRow, RunStatus } from "../ledger/runs";
import { effectHashCount } from "../processors/executor";
import { lineDiffStat } from "../proposals/diff-stat";
import type { PendingProposalRow } from "../proposals/pending-proposals";

const REASON = /dome\.agent\.garden opportunity ([a-z-]+):([a-f0-9]{12})/;
const GARDEN_PROCESSOR = "dome.agent.garden";
const RUN_STATUSES: ReadonlyArray<RunStatus> = Object.freeze([
  "queued", "running", "succeeded", "failed", "skipped", "timed_out", "cancelled",
]);

export type GardenCapabilityUsesByRun = {
  readonly runId: string;
  readonly uses: ReadonlyArray<CapabilityUseRow>;
};

export type CompileGardenQualityInput = {
  readonly proposals: ReadonlyArray<PendingProposalRow>;
  readonly runs: ReadonlyArray<RunRow>;
  readonly capabilityUsesByRun: ReadonlyArray<GardenCapabilityUsesByRun>;
  readonly currentOpportunityCount?: number | null;
};

export type GardenQualityReport = {
  readonly schema: "dome.eval.garden/v2";
  readonly opportunities: {
    readonly current: number | null;
  };
  readonly runs: {
    readonly total: number;
    readonly byStatus: Readonly<Record<RunStatus, number>>;
    readonly costed: number;
    readonly totalCostUsd: number | null;
    readonly meanCostUsd: number | null;
    readonly timed: number;
    readonly totalDurationMs: number | null;
    readonly meanDurationMs: number | null;
    readonly modelInvokeCount: number;
    /** Literal ledger shape; never interpreted as a clean/no-op judgment. */
    readonly succeededZeroEffects: number;
    readonly effectful: number;
  };
  readonly linkage: {
    readonly runsWithLinkedProposal: number;
    readonly effectfulWithoutLinkedProposal: number;
    readonly linkedRate: number | null;
    readonly proposalsWithoutRetainedRun: number;
    /** Null when retained capability evidence cannot support a count. */
    readonly patchProposeAttempts: number | null;
  };
  readonly proposals: {
    readonly proposed: number;
    readonly pending: number;
    readonly humanDecided: number;
    readonly applied: number;
    readonly ownerRejected: number;
    readonly expired: number;
    /** Usefulness proxy from explicit owner decisions; not opportunity precision. */
    readonly ownerApplyRate: number | null;
    readonly medianDecisionHours: number | null;
    readonly editSize: {
      readonly meanFiles: number | null;
      readonly meanAddedLines: number | null;
      readonly meanRemovedLines: number | null;
    };
    readonly changedEvidenceRecurrence: {
      readonly subjects: number;
      readonly recurringSubjects: number;
      readonly rate: number | null;
    };
    readonly byKind: Readonly<Record<string, {
      readonly proposed: number;
      readonly applied: number;
      readonly ownerRejected: number;
      readonly pending: number;
    }>>;
  };
};

/** Compile retained garden execution and decision evidence; never score it. */
export function compileGardenQuality(input: CompileGardenQualityInput): GardenQualityReport {
  const runs = input.runs.filter((row) => row.processorId === GARDEN_PROCESSOR);
  const gardenProposals = input.proposals.filter((row) => row.processorId === GARDEN_PROCESSOR);
  const parsed = gardenProposals.flatMap((row) => {
    const match = REASON.exec(row.reason);
    if (match === null) return [];
    return [{ row, kind: match[1]!, opportunityId: `${match[1]}:${match[2]}` }];
  });
  const runIds = new Set(runs.map((run) => String(run.id)));
  const linkedRunIds = new Set(
    parsed.flatMap(({ row }) =>
      row.runId !== null && runIds.has(row.runId) ? [row.runId] : []
    ),
  );
  const effectfulRuns = runs.filter((run) => effectHashCount(run.effectHashes) > 0);
  const linkedEffectfulRuns = effectfulRuns.filter((run) => linkedRunIds.has(String(run.id)));
  const allUses = input.capabilityUsesByRun
    .filter((entry) => runIds.has(entry.runId))
    .flatMap((entry) => entry.uses);
  const hasCapabilityEvidence = allUses.length > 0;
  const costs = runs.flatMap((run) => run.costUsd === null ? [] : [run.costUsd]);
  const durations = runs.flatMap((run) => run.durationMs === null ? [] : [run.durationMs]);
  const byStatus = Object.fromEntries(RUN_STATUSES.map((status) => [
    status,
    runs.filter((run) => run.status === status).length,
  ])) as Record<RunStatus, number>;

  let pending = 0;
  let applied = 0;
  let ownerRejected = 0;
  let expired = 0;
  const decisionHours: number[] = [];
  const fileCounts: number[] = [];
  const addedLines: number[] = [];
  const removedLines: number[] = [];
  const kinds = new Map<string, { proposed: number; applied: number; ownerRejected: number; pending: number }>();
  const subjects = new Map<string, Set<string>>();

  for (const item of parsed) {
    const { row, kind, opportunityId } = item;
    if (row.status === "pending") pending += 1;
    else if (row.status === "applied") applied += 1;
    else if (row.decidedBy === "expired") expired += 1;
    else ownerRejected += 1;

    if (row.status !== "pending" && row.decidedBy !== "expired") {
      const elapsed = elapsedHours(row.createdAt, row.decidedAt);
      if (elapsed !== null) decisionHours.push(elapsed);
    }
    fileCounts.push(row.changes.length);
    let proposalAdded = 0;
    let proposalRemoved = 0;
    for (const change of row.changes) {
      const stat = lineDiffStat(
        row.baseContents[change.path] ?? null,
        change.kind === "write" ? change.content : null,
      );
      proposalAdded += stat.added;
      proposalRemoved += stat.removed;
    }
    addedLines.push(proposalAdded);
    removedLines.push(proposalRemoved);

    const bucket = kinds.get(kind) ?? { proposed: 0, applied: 0, ownerRejected: 0, pending: 0 };
    bucket.proposed += 1;
    if (row.status === "pending") bucket.pending += 1;
    else if (row.status === "applied") bucket.applied += 1;
    else if (row.decidedBy !== "expired") bucket.ownerRejected += 1;
    kinds.set(kind, bucket);

    const sourcePaths = row.sourceRefs.map((ref) => String(ref.path));
    const paths = (sourcePaths.length > 0 ? sourcePaths : row.changes.map((change) => change.path))
      .sort(compareStrings);
    const subject = `${kind}|${paths.join("|")}`;
    const ids = subjects.get(subject) ?? new Set<string>();
    ids.add(opportunityId);
    subjects.set(subject, ids);
  }

  const humanDecided = applied + ownerRejected;
  const recurringSubjects = [...subjects.values()].filter((ids) => ids.size > 1).length;
  return Object.freeze({
    schema: "dome.eval.garden/v2" as const,
    opportunities: Object.freeze({ current: input.currentOpportunityCount ?? null }),
    runs: Object.freeze({
      total: runs.length,
      byStatus: Object.freeze(byStatus),
      costed: costs.length,
      totalCostUsd: sumOrNull(costs),
      meanCostUsd: mean(costs),
      timed: durations.length,
      totalDurationMs: sumOrNull(durations),
      meanDurationMs: mean(durations),
      modelInvokeCount: allUses.filter((use) => use.capability === "model.invoke").length,
      succeededZeroEffects: runs.filter(
        (run) => run.status === "succeeded" && effectHashCount(run.effectHashes) === 0,
      ).length,
      effectful: effectfulRuns.length,
    }),
    linkage: Object.freeze({
      runsWithLinkedProposal: linkedRunIds.size,
      effectfulWithoutLinkedProposal: effectfulRuns.filter(
        (run) => !linkedRunIds.has(String(run.id)),
      ).length,
      linkedRate: nullableRatio(linkedEffectfulRuns.length, effectfulRuns.length),
      proposalsWithoutRetainedRun: parsed.filter(
        ({ row }) => row.runId === null || !runIds.has(row.runId),
      ).length,
      patchProposeAttempts: hasCapabilityEvidence
        ? allUses.filter((use) => use.capability === "patch.propose").length
        : null,
    }),
    proposals: Object.freeze({
      proposed: parsed.length,
      pending,
      humanDecided,
      applied,
      ownerRejected,
      expired,
      ownerApplyRate: nullableRatio(applied, humanDecided),
      medianDecisionHours: median(decisionHours),
      editSize: Object.freeze({
        meanFiles: mean(fileCounts),
        meanAddedLines: mean(addedLines),
        meanRemovedLines: mean(removedLines),
      }),
      changedEvidenceRecurrence: Object.freeze({
        subjects: subjects.size,
        recurringSubjects,
        rate: nullableRatio(recurringSubjects, subjects.size),
      }),
      byKind: Object.freeze(Object.fromEntries(
        [...kinds.entries()]
          .sort(([a], [b]) => compareStrings(a, b))
          .map(([kind, value]) => [kind, Object.freeze(value)]),
      )),
    }),
  });
}

function elapsedHours(createdAt: string, decidedAt: string | null): number | null {
  if (decidedAt === null) return null;
  const elapsed = Date.parse(decidedAt) - Date.parse(createdAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed / 3_600_000 : null;
}

function nullableRatio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function sumOrNull(values: ReadonlyArray<number>): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

function mean(values: ReadonlyArray<number>): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
