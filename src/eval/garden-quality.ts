import { lineDiffStat } from "../proposals/diff-stat";
import type { PendingProposalRow } from "../proposals/pending-proposals";
import { compareStrings } from "../core/compare";

const REASON = /dome\.agent\.garden opportunity ([a-z-]+):([a-f0-9]{12})/;

export type GardenQualityReport = {
  readonly schema: "dome.eval.garden/v1";
  readonly proposed: number;
  readonly pending: number;
  readonly humanDecided: number;
  readonly applied: number;
  readonly ownerRejected: number;
  readonly expired: number;
  /** Usefulness proxy from explicit owner decisions; not ground-truth precision. */
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

/** Compile retained semantic-garden proposal decisions into an observational report. */
export function compileGardenQuality(
  rows: ReadonlyArray<PendingProposalRow>,
): GardenQualityReport {
  const parsed = rows.flatMap((row) => {
    if (row.processorId !== "dome.agent.garden") return [];
    const match = REASON.exec(row.reason);
    if (match === null) return [];
    return [{ row, kind: match[1]!, opportunityId: `${match[1]}:${match[2]}` }];
  });
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
    const paths = (sourcePaths.length > 0 ? sourcePaths : row.changes.map((change) => change.path)).sort();
    const subject = `${kind}|${paths.join("|")}`;
    const ids = subjects.get(subject) ?? new Set<string>();
    ids.add(opportunityId);
    subjects.set(subject, ids);
  }

  const humanDecided = applied + ownerRejected;
  const recurringSubjects = [...subjects.values()].filter((ids) => ids.size > 1).length;
  return Object.freeze({
    schema: "dome.eval.garden/v1",
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
