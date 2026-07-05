// dome.health.report-card — the pure renderers (separated from the processor
// wiring, the edition-blocks pattern). Aggregates run-ledger + question rows
// over the trailing 7 days and renders two deterministic surfaces: the full
// `meta/report-card.md` card and the `dome.health:report-card` daily block.
//
// Every function here is pure string/data work — no clock, no IO, no Effects.
// The processor (`report-card.ts`) owns the reads and the single PatchEffect.
//
// "Productive outcome" is defined crisply and deterministically as a run that
// reached `succeeded` AND emitted at least one effect (`effectCount > 0` —
// the operational run row's derived view of the ledger's per-run effect
// hashes). A succeeded zero-effect run is a genuine no-op: it counts as a run
// but never as productive, which is what lets the "possibly idle" section
// catch the dominant no-op-churn case (a deterministic indexer succeeding 200
// times a week while doing nothing). Stated in the rendered card and in
// [[wiki/specs/daily-surface]] §"Report card".

import { generatedBlockMarkers } from "../../../../src/core/generated-block";
import {
  MISS_ENTRY_PATTERN,
  RETRIEVAL_MISSES_PATH,
} from "../../../../src/surface/report-miss";

// The retrieval-miss log (Task 12); the miss row renders only when present.
// Re-exported so existing importers of this module (report-card.ts, its
// tests) keep working; src/surface/report-miss.ts is the single source of
// both the path and the entry grammar — see `countRetrievalMisses` below.
export { RETRIEVAL_MISSES_PATH };

// ----- Identity + constants --------------------------------------------------

// The daily block's `(owner, block)` identity — registered in dome.daily's
// DAILY_GENERATED_BLOCKS and dome.search's strip list as a plain cross-bundle
// entry (dome.health owns the writer; dome.daily only recognizes the id).
export const REPORT_CARD_OWNER = "dome.health";
export const REPORT_CARD_BLOCK = "report-card";
export const REPORT_CARD_MARKERS = generatedBlockMarkers(
  REPORT_CARD_OWNER,
  REPORT_CARD_BLOCK,
);

/** The full-card path, rewritten in place each week. */
export const REPORT_CARD_PATH = "meta/report-card.md";
/** Heading the daily block lands under. */
export const WEEKLY_REVIEW_HEADING = "## Weekly review";

export const REPORT_CARD_WINDOW_DAYS = 7;
/** A processor is "possibly idle" at ≥ this many runs with zero productive. */
export const POSSIBLY_IDLE_MIN_RUNS = 50;
/** Spenders shown in the daily block. */
export const TOP_SPENDERS = 3;

// ----- Input row shapes (narrow projections of the operational rows) ---------

export type ReportCardRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "timed_out"
  | "cancelled";

/** The run fields the aggregation needs — a narrow view of OperationalRunRow. */
export type ReportCardRunRow = {
  readonly processorId: string;
  readonly status: ReportCardRunStatus;
  readonly costUsd: number | null;
  /** Effects the run emitted; 0 on a succeeded run = a genuine no-op. */
  readonly effectCount: number;
  /** Skipped-run error JSON; carries `processor.quarantined` for quarantines. */
  readonly error: string | null;
};

/** The question fields the aggregation needs. */
export type ReportCardQuestionRow = {
  readonly processorId: string;
  readonly askedAt: string;
  readonly answeredAt: string | null;
  readonly state: "open" | "resolved";
};

// ----- Aggregated stats ------------------------------------------------------

export type ProcessorRunStats = {
  readonly processorId: string;
  readonly runs: number;
  readonly failures: number;
  readonly quarantines: number;
  readonly costUsd: number;
  readonly productive: number;
};

export type ProcessorQuestionStats = {
  readonly processorId: string;
  readonly opened: number;
  readonly resolved: number;
};

export type ReportCardData = {
  /** Vault-local YYYY-MM-DD the trailing window ends on (report day). */
  readonly windowEnd: string;
  readonly runs: ReadonlyArray<ProcessorRunStats>;
  readonly questions: ReadonlyArray<ProcessorQuestionStats>;
  /** null → the misses file is absent (row omitted entirely). */
  readonly missCount: number | null;
  /** Processors with ≥ POSSIBLY_IDLE_MIN_RUNS runs and zero productive. */
  readonly idle: ReadonlyArray<ProcessorRunStats>;
};

const FAILURE_STATUSES: ReadonlySet<ReportCardRunStatus> = new Set([
  "failed",
  "timed_out",
  "cancelled",
]);
const QUARANTINE_MARKER = "processor.quarantined";

/**
 * Fold run rows into per-processor stats, sorted by processorId ascending
 * (deterministic order). Quarantines are `skipped` runs whose error carries
 * the `processor.quarantined` marker (the runtime records a quarantine-gated
 * skip that way); failures are the terminal problem statuses; productive is
 * `succeeded` with at least one emitted effect (a succeeded zero-effect run
 * is a genuine no-op — see the module header).
 */
export function aggregateRunStats(
  rows: ReadonlyArray<ReportCardRunRow>,
): ReadonlyArray<ProcessorRunStats> {
  const byId = new Map<
    string,
    { runs: number; failures: number; quarantines: number; costUsd: number; productive: number }
  >();
  for (const row of rows) {
    const stat = byId.get(row.processorId) ?? {
      runs: 0,
      failures: 0,
      quarantines: 0,
      costUsd: 0,
      productive: 0,
    };
    stat.runs += 1;
    if (FAILURE_STATUSES.has(row.status)) stat.failures += 1;
    if (
      row.status === "skipped" &&
      row.error !== null &&
      row.error.includes(QUARANTINE_MARKER)
    ) {
      stat.quarantines += 1;
    }
    if (row.status === "succeeded" && row.effectCount > 0) stat.productive += 1;
    stat.costUsd += row.costUsd ?? 0;
    byId.set(row.processorId, stat);
  }
  return Object.freeze(
    [...byId.entries()]
      .map(([processorId, s]) => Object.freeze({ processorId, ...s }))
      .sort((a, b) => (a.processorId < b.processorId ? -1 : a.processorId > b.processorId ? 1 : 0)),
  );
}

/**
 * Count questions opened (askedAt in window) and resolved (answeredAt in
 * window) per asking processor, sorted by processorId ascending. `windowStart`
 * is an ISO-8601 lower bound compared lexically (ISO timestamps sort
 * chronologically).
 */
export function aggregateQuestionStats(
  rows: ReadonlyArray<ReportCardQuestionRow>,
  windowStartIso: string,
): ReadonlyArray<ProcessorQuestionStats> {
  const byId = new Map<string, { opened: number; resolved: number }>();
  for (const row of rows) {
    const stat = byId.get(row.processorId) ?? { opened: 0, resolved: 0 };
    if (row.askedAt >= windowStartIso) stat.opened += 1;
    if (
      row.state === "resolved" &&
      row.answeredAt !== null &&
      row.answeredAt >= windowStartIso
    ) {
      stat.resolved += 1;
    }
    byId.set(row.processorId, stat);
  }
  return Object.freeze(
    [...byId.entries()]
      .map(([processorId, s]) => Object.freeze({ processorId, ...s }))
      // Drop processors with no activity in the window (all-zero rows add noise).
      .filter((s) => s.opened > 0 || s.resolved > 0)
      .sort((a, b) => (a.processorId < b.processorId ? -1 : a.processorId > b.processorId ? 1 : 0)),
  );
}

/** The processors flagged "possibly idle": ≥ threshold runs, zero productive. */
export function possiblyIdle(
  runs: ReadonlyArray<ProcessorRunStats>,
): ReadonlyArray<ProcessorRunStats> {
  return Object.freeze(
    runs.filter((s) => s.runs >= POSSIBLY_IDLE_MIN_RUNS && s.productive === 0),
  );
}

/**
 * Count retrieval-miss log entries whose date falls in the trailing window.
 * Task 12's entry grammar is `- YYYY-MM-DD — "<query>" — <note>`
 * (`src/surface/report-miss.ts`'s `MISS_ENTRY_PATTERN` — the single source,
 * imported rather than re-derived here); this counts the date-prefixed
 * bullets whose date is one of `windowDates`.
 */
export function countRetrievalMisses(
  content: string,
  windowDates: ReadonlySet<string>,
): number {
  let count = 0;
  for (const line of content.split("\n")) {
    const match = MISS_ENTRY_PATTERN.exec(line);
    const date = match?.[1];
    if (date !== undefined && windowDates.has(date)) count += 1;
  }
  return count;
}

// ----- Renderers -------------------------------------------------------------

function money(n: number): string {
  return n.toFixed(2);
}

/**
 * Render the full `meta/report-card.md` card — deterministic markdown,
 * rewritten in place each week. Per-processor table, questions table, an
 * optional retrieval-miss line (only when the misses file exists), and the
 * possibly-idle section.
 */
export function renderReportCard(data: ReportCardData): string {
  const lines: string[] = [
    "---",
    "type: report-card",
    `window-end: ${data.windowEnd}`,
    "---",
    "",
    "# Weekly report card",
    "",
    `_Trailing 7 days ending ${data.windowEnd}. Productive = \`succeeded\` runs that emitted at least one effect; a succeeded zero-effect run is a no-op — it counts as a run, never as productive._`,
    "",
    "## Per-processor",
    "",
  ];
  if (data.runs.length === 0) {
    lines.push("_No runs in the last 7 days._");
  } else {
    lines.push(
      "| Processor | Runs | Failures | Quarantines | Model cost (USD) | Productive |",
      "| --- | --: | --: | --: | --: | --: |",
      ...data.runs.map(
        (s) =>
          `| ${s.processorId} | ${s.runs} | ${s.failures} | ${s.quarantines} | ${money(s.costUsd)} | ${s.productive} |`,
      ),
    );
  }
  lines.push("", "## Questions", "");
  if (data.questions.length === 0) {
    lines.push("_No questions opened or resolved in the last 7 days._");
  } else {
    lines.push(
      "| Processor | Opened | Resolved |",
      "| --- | --: | --: |",
      ...data.questions.map(
        (s) => `| ${s.processorId} | ${s.opened} | ${s.resolved} |`,
      ),
    );
  }
  if (data.missCount !== null) {
    lines.push(
      "",
      "## Retrieval misses",
      "",
      `_${data.missCount} retrieval ${data.missCount === 1 ? "miss" : "misses"} logged this week._`,
    );
  }
  lines.push("", "## Possibly idle", "");
  if (data.idle.length === 0) {
    lines.push("_None._");
  } else {
    lines.push(
      ...data.idle.map(
        (s) => `- ${s.processorId} — ${s.runs} runs, 0 productive outcomes`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Render the `dome.health:report-card` daily block (≤10 lines): total model
 * cost, top-3 spenders with productive counts, questions opened/resolved, the
 * miss count (only when the misses file exists), and the full-card link. Plain
 * `-` bullets only. Returns the full block including markers.
 */
export function renderDailyReviewBlock(data: ReportCardData): string {
  const totalCost = data.runs.reduce((sum, s) => sum + s.costUsd, 0);
  const spenders = [...data.runs]
    .filter((s) => s.costUsd > 0)
    .sort((a, b) =>
      b.costUsd - a.costUsd !== 0
        ? b.costUsd - a.costUsd
        : a.processorId < b.processorId
          ? -1
          : a.processorId > b.processorId
            ? 1
            : 0,
    )
    .slice(0, TOP_SPENDERS);
  const spendersText =
    spenders.length === 0
      ? "none"
      : spenders
          .map((s) => `${s.processorId} $${money(s.costUsd)} (${s.productive} productive)`)
          .join(", ");
  const openedTotal = data.questions.reduce((sum, s) => sum + s.opened, 0);
  const resolvedTotal = data.questions.reduce((sum, s) => sum + s.resolved, 0);

  const lines: string[] = [
    REPORT_CARD_MARKERS.start,
    "### Report card",
    `- Model cost (7d): $${money(totalCost)}`,
    `- Top spenders: ${spendersText}`,
    `- Questions: ${openedTotal} opened / ${resolvedTotal} resolved`,
  ];
  if (data.missCount !== null) {
    lines.push(`- Retrieval misses: ${data.missCount}`);
  }
  lines.push("- Full card: [[meta/report-card]]", REPORT_CARD_MARKERS.end);
  return lines.join("\n");
}
