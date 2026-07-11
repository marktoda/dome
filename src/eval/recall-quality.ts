export type RecallJob =
  | "people"
  | "decision-provenance"
  | "meeting-prep"
  | "project-state"
  | "cross-page-synthesis";

export type RecallCorpusDocument = {
  readonly path: string;
  readonly title: string;
  readonly body: string;
  readonly category: string;
  readonly type?: string;
};

export type RecallCorpusQuery = {
  readonly id: string;
  readonly job: RecallJob;
  readonly question: string;
  readonly relevantPaths: ReadonlyArray<string>;
  readonly forbiddenPaths?: ReadonlyArray<string>;
};

export type RecallCorpus = {
  readonly schema: "dome.eval.recall-corpus/v1";
  readonly version: string;
  readonly documents: ReadonlyArray<RecallCorpusDocument>;
  readonly queries: ReadonlyArray<RecallCorpusQuery>;
  readonly floors: {
    readonly relevantRecallAt5: number;
    readonly allTargetsSuccessAt5: number;
    readonly maxForbiddenHitsAt10: number;
  };
};

export type RecallFailure = {
  readonly queryId: string;
  readonly missingPaths: ReadonlyArray<string>;
  readonly forbiddenPaths: ReadonlyArray<string>;
  readonly retrievedPaths: ReadonlyArray<string>;
};

export type RecallQualityReport = {
  readonly schema: "dome.eval.recall/v1";
  readonly corpusVersion: string;
  readonly queryCount: number;
  readonly relevantRecallAt5: number;
  readonly allTargetsSuccessAt5: number;
  readonly meanReciprocalRankAt5: number;
  readonly forbiddenHitsAt10: number;
  readonly byJob: Readonly<Record<RecallJob, {
    readonly queries: number;
    readonly relevantRecallAt5: number;
    readonly allTargetsSuccessAt5: number;
  }>>;
  readonly failures: ReadonlyArray<RecallFailure>;
  readonly passed: boolean;
};

type Retrieve = (
  query: RecallCorpusQuery,
  limit: number,
) => ReadonlyArray<{ readonly path: string }>;

const JOBS: ReadonlyArray<RecallJob> = Object.freeze([
  "people",
  "decision-provenance",
  "meeting-prep",
  "project-state",
  "cross-page-synthesis",
]);

/** Score a versioned corpus through an injected retrieval interface. */
export function scoreRecallCorpus(
  corpus: RecallCorpus,
  retrieve: Retrieve,
): RecallQualityReport {
  let relevant = 0;
  let found = 0;
  let allTargets = 0;
  let reciprocalRank = 0;
  let forbiddenHits = 0;
  const failures: RecallFailure[] = [];
  const jobTotals = new Map<RecallJob, { queries: number; relevant: number; found: number; all: number }>();
  for (const job of JOBS) jobTotals.set(job, { queries: 0, relevant: 0, found: 0, all: 0 });

  for (const query of corpus.queries) {
    const paths = unique(retrieve(query, 10).map((item) => item.path)).slice(0, 10);
    const top5 = paths.slice(0, 5);
    const missing = query.relevantPaths.filter((path) => !top5.includes(path));
    const forbidden = (query.forbiddenPaths ?? []).filter((path) => paths.includes(path));
    const firstRelevant = top5.findIndex((path) => query.relevantPaths.includes(path));
    const queryFound = query.relevantPaths.length - missing.length;
    relevant += query.relevantPaths.length;
    found += queryFound;
    if (missing.length === 0) allTargets += 1;
    if (firstRelevant >= 0) reciprocalRank += 1 / (firstRelevant + 1);
    forbiddenHits += forbidden.length;

    const job = jobTotals.get(query.job)!;
    job.queries += 1;
    job.relevant += query.relevantPaths.length;
    job.found += queryFound;
    if (missing.length === 0) job.all += 1;

    if (missing.length > 0 || forbidden.length > 0) {
      failures.push(Object.freeze({
        queryId: query.id,
        missingPaths: Object.freeze(missing),
        forbiddenPaths: Object.freeze(forbidden),
        retrievedPaths: Object.freeze(paths),
      }));
    }
  }

  const queryCount = corpus.queries.length;
  const relevantRecallAt5 = ratio(found, relevant);
  const allTargetsSuccessAt5 = ratio(allTargets, queryCount);
  const byJob = Object.fromEntries(JOBS.map((job) => {
    const value = jobTotals.get(job)!;
    return [job, Object.freeze({
      queries: value.queries,
      relevantRecallAt5: ratio(value.found, value.relevant),
      allTargetsSuccessAt5: ratio(value.all, value.queries),
    })];
  })) as Record<RecallJob, { queries: number; relevantRecallAt5: number; allTargetsSuccessAt5: number }>;

  return Object.freeze({
    schema: "dome.eval.recall/v1",
    corpusVersion: corpus.version,
    queryCount,
    relevantRecallAt5,
    allTargetsSuccessAt5,
    meanReciprocalRankAt5: ratio(reciprocalRank, queryCount),
    forbiddenHitsAt10: forbiddenHits,
    byJob: Object.freeze(byJob),
    failures: Object.freeze(failures),
    passed:
      relevantRecallAt5 >= corpus.floors.relevantRecallAt5 &&
      allTargetsSuccessAt5 >= corpus.floors.allTargetsSuccessAt5 &&
      forbiddenHits <= corpus.floors.maxForbiddenHitsAt10,
  });
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function unique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}
