// dome.daily.stale-task-warden — schedule-driven attention warden that surfaces
// stale and overdue tasks as structured, resolvable owner questions.
//
// A task is "stale" when EITHER:
//   (a) OVERDUE: it carries a 📅 YYYY-MM-DD due date that is ≥ STALE_OVERDUE_DAYS
//       (= 14) days before today — i.e., dueDate ≤ today − 14 days. The 14-day
//       grace window prevents noise from recently-missed tasks while surfacing
//       genuinely forgotten ones.
//   (b) DISCOUNTED: it is UNDATED and carries an attention discount ≥
//       ATTENTION_STALE_THRESHOLD (= 0.4 — from attention-shared). Dated tasks
//       with discount = 0 (exempt) are excluded from rule (b) by definition:
//       if they are overdue enough they surface via rule (a), otherwise they are
//       not stale yet.
//
// Design decision — CLOCK AND DETERMINISM:
//   Rule (a) reads `ctx.now()` to compare against today's date. The output
//   therefore depends on the clock, so this processor is NOT registered as
//   `execution.class: deterministic` (unlike dome.daily.attention-discount, which
//   deliberately uses the newest-daily date as a clock-free reference). This
//   processor matches the posture of dome.daily.create-daily and
//   dome.daily.close-scaffold: garden phase, schedule-only trigger (daily cron),
//   no `execution.class` override. A cron tick is the natural cadence: staleness
//   doesn't change by the minute, and scheduling once-a-day keeps the
//   question ledger stable.
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
//   - `collectAttentionDiscounts` (from attention-shared) for discount data.
//     This is a pure snapshot scan; no projection needed.
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

import {
  ATTENTION_STALE_THRESHOLD,
  collectAttentionDiscounts,
} from "./attention-shared";
import { dailyPathSettings, formatDate, localDateParts } from "./daily-paths";
import { openLoopIdentity, openLoopSurfaceSources, taskStableId } from "./open-loop-surface";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * A dated task overdue by at least this many days is considered stale.
 * Grace window: 13 days of overdue is still "probably on the radar";
 * 14 days means it has been genuinely forgotten for two weeks.
 */
export const STALE_OVERDUE_DAYS = 14;

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
// Processor
// ---------------------------------------------------------------------------

const staleTaskWarden = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    // Today as a YYYY-MM-DD string via the injected clock (processor-clock fence).
    const today = formatDate(localDateParts(ctx.now()));

    const settings = dailyPathSettings(ctx.extensionConfig);

    // Collect attention discounts for all anchored open-loop items in the snapshot.
    // This is a pure snapshot scan — no projection required, matches posture of
    // the attention-discount processor. Keyed by openLoopIdentity (sourcePath + body).
    const discounts = await collectAttentionDiscounts({
      snapshot: ctx.snapshot,
      settings,
    });

    // Enumerate all open-loop surface items across the entire vault.
    // `openLoopSurfaceSources` returns items from non-daily source files that
    // carry surface-eligible action items. For completeness we also scan ALL
    // markdown files, but openLoopSurfaceSources already handles that.
    const allPaths = await ctx.snapshot.listMarkdownFiles();
    const effects: QuestionEffect[] = [];

    // Deduplicate by stableId: a task may appear in multiple source files
    // (e.g., via carry-forward copies). We track which stableIds have been
    // questioned to ensure one question per task.
    const questionedIds = new Set<string>();

    for (const path of allPaths) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      const items = openLoopSurfaceSources({ path, content, settings });
      for (const item of items) {
        const stableId = item.stableId;
        if (questionedIds.has(stableId)) continue;

        const dueDate = extractDueDate(item.body);
        let isStale = false;
        let staleness: "overdue" | "discounted" = "overdue";

        if (dueDate !== null) {
          // Rule (a): overdue check — how many days overdue is this task?
          const daysOverdue = wholeDaysBetween(dueDate, today);
          if (daysOverdue >= STALE_OVERDUE_DAYS) {
            isStale = true;
            staleness = "overdue";
          }
          // Dated tasks with dueDate are exempt from discount rule (b).
          // Even if discount=0 (exempt), rule (a) still applies independently.
        } else {
          // Rule (b): undated task — check attention discount.
          const identityKey = openLoopIdentity({
            sourcePath: item.sourcePath,
            body: item.body,
          });
          const discountEntry = discounts.get(identityKey);
          if (
            discountEntry !== undefined &&
            discountEntry.discount >= ATTENTION_STALE_THRESHOLD
          ) {
            isStale = true;
            staleness = "discounted";
          }
        }

        if (!isStale) continue;

        questionedIds.add(stableId);

        const idempotencyKey = `dome.daily.settle-stale:${stableId}`;
        const questionText =
          staleness === "overdue"
            ? `Stale overdue task in ${item.sourcePath} (due ${dueDate}, ${wholeDaysBetween(dueDate!, today)} days overdue): "${item.body}". Close, defer, or keep?`
            : `Stale discounted task in ${item.sourcePath} (attention-discounted, no due date): "${item.body}". Close, defer, or keep?`;

        effects.push(
          questionEffect({
            question: questionText,
            options: [...SETTLE_STALE_OPTIONS],
            idempotencyKey,
            metadata: {
              automationPolicy: "owner-needed",
              destination: item.sourcePath,
              ...(dueDate !== null ? { material: dueDate } : {}),
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
    }

    return Object.freeze(effects);
  },
});

export default staleTaskWarden;
