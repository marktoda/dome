// dome.daily.stale-task-warden — schedule-driven attention warden that surfaces
// overdue tasks as structured, resolvable owner questions.
//
// A task is "stale" iff it is OVERDUE: it carries a 📅 YYYY-MM-DD due date
// that is ≥ STALE_OVERDUE_DAYS (= 14) days before today — i.e. dueDate ≤
// today − 14 days. The 14-day grace window prevents noise from recently-missed
// tasks while surfacing genuinely forgotten ones. Undated tasks are never
// stale-question candidates (docs/cohesive/brainstorms/
// 2026-07-02-pruning-pass-design.md §2: "staleness = overdue ≥ 14 days,
// PERIOD"); an undated task ranks by recency in open-loops until it is dated
// or settled.
//
// Design decision — CLOCK AND DETERMINISM:
//   This rule reads `ctx.now()` to compare against today's date. The output
//   therefore depends on the clock, so this processor is NOT registered as
//   `execution.class: deterministic`. This processor matches the posture of
//   dome.daily.create-daily and dome.daily.close-scaffold: garden phase,
//   schedule-only trigger (daily cron), no `execution.class` override. A
//   cron tick is the natural cadence: staleness doesn't change by the
//   minute, and scheduling once-a-day keeps the question ledger stable.
//
// Design decision — ONE QUESTION PER STALE TASK, STABLE KEY:
//   idempotencyKey = `dome.daily.settle-stale:${stableId}`
//   where stableId = `dome.daily.open-loop:${anchor}` for anchored tasks, or
//   the path+body hash for unanchored ones (via taskStableId). An answered
//   question never re-emits (the projection's question deduplication gates on
//   idempotencyKey). Re-running the processor over the same snapshot + now
//   is therefore idempotent.
//
// Triggers: cron `0 6 * * *` (daily morning, same as create-daily). No file
//   signal trigger — staleness is a daily property, not a per-commit fact.
//
// Grant: `question.ask` (must be declared in manifest.yaml capabilities).
//
// Data sources:
//   - `openLoopSurfaceSources` (from open-loop-surface) for all open-loop
//     items with their stableId, body, anchor, and sourcePath.
//   - Task due dates are extracted inline from the body text (same regex
//     action-state uses: `📅 YYYY-MM-DD`).

import {
  questionEffect,
  type Effect,
  type QuestionEffect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import { dailyPathSettings, formatDate, localDateParts } from "./daily-paths";
import { openLoopSurfaceSources } from "./open-loop-surface";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * A dated task overdue by at least this many days is considered stale.
 * Grace window: 13 days of overdue is still "probably on the radar";
 * 14 days means it has been genuinely forgotten for two weeks.
 */
export const STALE_OVERDUE_DAYS = 14;

/**
 * Maximum number of settle-stale questions emitted per warden run. Mirrors
 * `MAX_STALE_LOOPS` in dome.agent's brief-shared — the brief caps stale-loop
 * entries at 8 to avoid flooding the morning surface; the warden uses the same
 * ceiling so the question ledger never grows faster than the owner can clear it.
 *
 * On each run, the warden sorts by days-overdue descending (most overdue
 * first) and emits questions for only the top MAX_SETTLE_STALE. Already-
 * resolved questions never re-emit (stable idempotencyKey), so on subsequent
 * mornings the next-worst surface as earlier ones get resolved — a
 * manageable rolling batch.
 */
export const MAX_SETTLE_STALE = 8;

/** Options presented to the owner for a stale task. */
const SETTLE_STALE_OPTIONS = Object.freeze(["close", "defer", "keep"] as const);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a `📅 YYYY-MM-DD` due date from a task body.
 * Returns the date string (YYYY-MM-DD) or null.
 */
function extractDueDate(body: string): string | null {
  return /(?:^|\s)📅\s*(\d{4}-\d{2}-\d{2})(?=\s|$)/u.exec(body)?.[1] ?? null;
}

/**
 * Compute whole days between two YYYY-MM-DD date strings.
 * Returns (to - from) in whole days; negative if from is after to.
 */
function wholeDaysBetween(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return 0;
  return Math.round((toMs - fromMs) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A candidate stale (overdue) task before question emission. */
type StaleCandidate = {
  readonly item: ReturnType<typeof openLoopSurfaceSources>[number];
  readonly daysOverdue: number;
  readonly dueDate: string;
};

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

const staleTaskWarden = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    // Today as a YYYY-MM-DD string via the injected clock (processor-clock fence).
    const today = formatDate(localDateParts(ctx.now()));

    const settings = dailyPathSettings(ctx.extensionConfig);

    // Enumerate all open-loop surface items across the vault source files.
    const allPaths = await ctx.snapshot.listMarkdownFiles();

    // Deduplicate by stableId: a task may appear in multiple source files
    // (e.g., via carry-forward copies). We track which stableIds have been
    // seen to ensure one candidate per task.
    const seenIds = new Set<string>();

    // Phase 1: collect all stale (overdue) candidates without emitting yet.
    const candidates: StaleCandidate[] = [];

    for (const path of allPaths) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      const items = openLoopSurfaceSources({ path, content, settings });
      for (const item of items) {
        const stableId = item.stableId;
        if (seenIds.has(stableId)) continue;

        const dueDate = extractDueDate(item.body);
        // Undated tasks are never stale-question candidates — staleness is
        // overdue-only (task-lifecycle §"Staleness").
        if (dueDate === null) continue;

        const daysOverdue = wholeDaysBetween(dueDate, today);
        if (daysOverdue < STALE_OVERDUE_DAYS) continue;

        // Unanchored tasks are skipped: the settle-stale-answer handler requires
        // material (the anchor) to locate and rewrite the origin line. An
        // unanchored task is not yet stamped (stamp-block-id runs on the next
        // cycle); it will become eligible once anchored.
        if (item.anchor === undefined) continue;

        seenIds.add(stableId);
        candidates.push({ item, daysOverdue, dueDate });
      }
    }

    // Phase 2: sort by days-overdue descending (most overdue first).
    candidates.sort((a, b) => b.daysOverdue - a.daysOverdue);

    // Phase 3: emit questions for only the top MAX_SETTLE_STALE candidates.
    // Already-resolved questions (by stable idempotencyKey) don't re-emit —
    // the question ledger's deduplication gates on idempotencyKey. On subsequent
    // mornings the next-worst surface as earlier ones get resolved.
    const effects: QuestionEffect[] = [];
    for (const candidate of candidates.slice(0, MAX_SETTLE_STALE)) {
      const { item, daysOverdue, dueDate } = candidate;
      const stableId = item.stableId;
      const idempotencyKey = `dome.daily.settle-stale:${stableId}`;
      const questionText =
        `Stale overdue task in ${item.sourcePath} (due ${dueDate}, ${daysOverdue} days overdue): "${item.body}". Close, defer, or keep?`;

      // `anchor` is carried in `material` — QuestionMetadata.material is the
      // documented round-trip context field for answer handlers (see effect.ts
      // §QuestionMetadata). QuestionMetadata is a strict Zod schema so unknown
      // fields are not allowed; material is the correct load-bearing slot.
      //
      // The settle-stale-answer processor reads the anchor as:
      //   const anchor = q.metadata?.material;
      //   // locate the origin line: `^${anchor}` suffix on the task line in
      //   // q.metadata?.destination (the source file path).
      // Candidates are filtered to anchored items above, but `item.anchor`'s
      // declared type stays optional across that array boundary — guard again
      // rather than assert.
      const anchor = item.anchor ?? null;
      effects.push(
        questionEffect({
          question: questionText,
          options: [...SETTLE_STALE_OPTIONS],
          idempotencyKey,
          metadata: {
            automationPolicy: "owner-needed",
            recommendedAnswer: "keep",
            destination: item.sourcePath,
            ...(anchor !== null ? { material: anchor } : {}),
          },
          sourceRefs: [
            ctx.sourceRef(
              item.sourcePath,
              { startLine: item.line, endLine: item.line },
              stableId,
            ),
          ],
        }),
      );
    }

    return Object.freeze(effects);
  },
});

export default staleTaskWarden;
