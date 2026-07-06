// dome.health.report-card — the weekly garden report (product review's "prove"
// instrument). Cron `22 5 * * 1` (Monday 05:22, before the 05:30 brief).
//
// Deterministic garden processor: NO model, NO facts, NO questions asked (it
// only reads them). Reads the run ledger (run.read) and question rows
// (questions.read) — both the trailing-7-day window (opened/resolved stats)
// and the full open backlog (Task 10's aging-decisions partition, §"Question
// aging escalation") — plus the optional retrieval-miss log, and emits ONE
// PatchEffect that rewrites `meta/report-card.md` (the full per-processor
// card) AND splices the `dome.health:report-card` block into TODAY's daily
// under `## Weekly review`.
// Byte-identical re-render is a no-op (the deterministic gate): when neither
// file's content changes, no patch is emitted. When the operational run view
// is absent (run.read declared but ungranted), the card is NOT overwritten and
// a LOUD warning fires — the degradation ladder, never a silent empty card.
//
// Normative: [[wiki/specs/daily-surface]] §"Report card" (choreography row
// 05:22 Monday + block-ownership row); the block id registers in dome.daily's
// DAILY_GENERATED_BLOCKS and dome.search's strip list.

import { compareStrings } from "../../../../src/core/compare";
import {
  diagnosticEffect,
  patchEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  dailyPath,
  dailyPathSettings,
  formatDate,
  localDateParts,
  parseScheduleInput,
  previousLocalDate,
} from "../../dome.daily/processors/daily-paths";
import { renderDailySkeleton } from "../../dome.daily/processors/daily-scaffold";
import {
  partitionQuestionsByAge,
  questionAgingDaysFromConfig,
  replaceEditionBlock,
  toEditionQuestion,
} from "../../dome.daily/processors/edition-blocks";

import {
  aggregateQuestionStats,
  aggregateRunStats,
  countRetrievalMisses,
  possiblyIdle,
  renderDailyReviewBlock,
  renderReportCard,
  REPORT_CARD_BLOCK,
  REPORT_CARD_OWNER,
  REPORT_CARD_PATH,
  REPORT_CARD_WINDOW_DAYS,
  RETRIEVAL_MISSES_PATH,
  WEEKLY_REVIEW_HEADING,
  type ReportCardData,
} from "./report-card-render";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The trailing-window date strings (windowEnd and the prior N-1 days). */
function windowDateSet(windowEnd: Date, days: number): ReadonlySet<string> {
  const dates = new Set<string>();
  for (let i = 0; i < days; i += 1) {
    dates.add(formatDate(localDateParts(new Date(windowEnd.getTime() - i * DAY_MS))));
  }
  return dates;
}

const reportCard = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const settings = dailyPathSettings(ctx.extensionConfig);
    // Weekly cron only; the scheduled fire time drives the window (signal
    // fires carry no firedAt — the current vault-local instant is the fallback).
    const firedAt = parseScheduleInput(ctx.input)?.firedAt ?? null;
    const now = firedAt === null ? ctx.now() : new Date(firedAt);
    const date = localDateParts(now);
    const windowEnd = formatDate(date);
    const todayPath = dailyPath(date, settings);
    // Task 10's aging threshold — same key + default as dome.daily.compose-
    // blocks (questionAgingDaysFromConfig), resolved from THIS processor's own
    // extensionConfig (a per-processor grant, not shared state).
    const agingDays = questionAgingDaysFromConfig(ctx.extensionConfig);
    // Two deliberate window semantics coexist: runs/questions use an exact
    // 168-hour ISO-instant bound (windowStartIso — the ledger rows carry
    // timestamps), while retrieval misses use the trailing 7 vault-local
    // calendar dates (windowDateSet — Task 12's entries carry only a
    // YYYY-MM-DD). Both derive from the same firedAt, so re-renders stay
    // byte-identical.
    const windowStartIso = new Date(
      now.getTime() - REPORT_CARD_WINDOW_DAYS * DAY_MS,
    ).toISOString();

    const diagnostics: Effect[] = [];

    // Runs are the spine of the card. A missing run view (run.read declared
    // but ungranted) is LOUD and skips the write — never overwrite a good card
    // with an empty one (NEEDS_ARE_LOUD, the degradation ladder).
    const runsView = ctx.operational?.runs;
    if (runsView === undefined) {
      return Object.freeze([
        diagnosticEffect({
          severity: "warning",
          code: "dome.health.report-card-runs-view-missing",
          message:
            "dome.health.report-card declares run.read but received no run view; the weekly card is not written",
          sourceRefs: [ctx.sourceRef(REPORT_CARD_PATH)],
        }),
      ]);
    }
    const runRows = runsView({ startedSince: windowStartIso });

    // Questions are secondary; a missing view degrades to an empty section
    // (LOUD warning), the card still renders from run data.
    const questionsView = ctx.operational?.questions;
    let questionStats: ReportCardData["questions"] = Object.freeze([]);
    let agingQuestions: ReportCardData["agingQuestions"] = Object.freeze([]);
    if (questionsView === undefined) {
      diagnostics.push(
        diagnosticEffect({
          severity: "warning",
          code: "dome.health.report-card-questions-view-missing",
          message:
            "dome.health.report-card declares questions.read but received no questions view; the questions section is omitted",
          sourceRefs: [ctx.sourceRef(REPORT_CARD_PATH)],
        }),
      );
    } else {
      questionStats = aggregateQuestionStats(
        questionsView({ resolvedSince: windowStartIso }),
        windowStartIso,
      );
      // Task 10: the full open backlog (not window-scoped — a question opened
      // long before this week's window can still be aging), partitioned by
      // the same rule dome.daily.compose-blocks uses, oldest-first.
      const { aging } = partitionQuestionsByAge(questionsView({ resolved: false }), {
        agingDays,
        nowIso: now.toISOString(),
      });
      agingQuestions = Object.freeze(
        [...aging]
          .map(toEditionQuestion)
          .sort((a, b) => compareStrings(a.askedAt, b.askedAt)),
      );
    }

    // The retrieval-miss row renders only when the log file exists (Task 12).
    const missesRaw = await ctx.snapshot.readFile(RETRIEVAL_MISSES_PATH);
    const missCount =
      missesRaw === null
        ? null
        : countRetrievalMisses(
            missesRaw,
            windowDateSet(now, REPORT_CARD_WINDOW_DAYS),
          );

    const runStats = aggregateRunStats(runRows);
    const data: ReportCardData = Object.freeze({
      windowEnd,
      runs: runStats,
      questions: questionStats,
      missCount,
      idle: possiblyIdle(runStats),
      agingQuestions,
    });

    // The full card — rewritten in place.
    const newCard = renderReportCard(data);
    const existingCard = await ctx.snapshot.readFile(REPORT_CARD_PATH);

    // The daily block — spliced into TODAY's daily (skeleton created when
    // absent, so create-daily/compose-blocks later no-op, the shared pattern).
    const existingDaily = await ctx.snapshot.readFile(todayPath);
    const dailyBase =
      existingDaily ??
      renderDailySkeleton({
        today: date,
        yesterday: previousLocalDate(date),
        settings,
      });
    const newDaily = replaceEditionBlock({
      content: dailyBase,
      owner: REPORT_CARD_OWNER,
      block: REPORT_CARD_BLOCK,
      section: renderDailyReviewBlock(data),
      heading: WEEKLY_REVIEW_HEADING,
    });

    // Byte-identical re-render is a no-op — the deterministic gate covering
    // BOTH files. Emit nothing when neither changed.
    if (newCard === existingCard && newDaily === existingDaily) {
      return Object.freeze([...diagnostics]);
    }

    // ONE PatchEffect covering both files (atomic — never a half-written
    // package). An unchanged file is still included; its write produces no git
    // diff at commit time.
    const changes: FileChangeInput[] = [
      { kind: "write", path: REPORT_CARD_PATH, content: newCard },
      { kind: "write", path: todayPath, content: newDaily },
    ];
    return Object.freeze([
      ...diagnostics,
      patchEffect({
        mode: "auto",
        changes,
        reason: `dome.health: weekly report card for the 7 days ending ${windowEnd}`,
        sourceRefs: [ctx.sourceRef(REPORT_CARD_PATH), ctx.sourceRef(todayPath)],
      }),
    ]);
  },
});

export default reportCard;
