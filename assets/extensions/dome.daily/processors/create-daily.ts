// dome.daily.create-daily — create today's daily note skeleton.
//
// The scheduled processor only creates the daily page if it is absent. It
// seeds the open-loop surface from current source-backed actions; the
// carry-forward processor keeps that surface fresh on source changes and
// scheduled maintenance ticks.

import {
  patchEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../src/core/effect";
import type { SourceRef } from "../../../../src/core/source-ref";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  attentionAdjustedRecencyIso,
  collectAttentionDiscounts,
} from "./attention-shared";
import {
  dailyPathSettings,
  dailyPath,
  ensureYesterdayFallbackSection,
  localDateParts,
  openLoopFreshnessKey,
  openLoopIdentity,
  openLoopSurfaceSection,
  openLoopSurfaceSources,
  previousLocalDate,
  previousDailyDigest,
  rankDailyOpenLoopSurfaceItems,
  renderDailySkeleton,
  replaceOpenLoopSurfaceSection,
  yesterdayFallbackSection,
  type DailyOpenLoopCandidate,
  type DailyOpenLoopSource,
  type DailyPathSettings,
} from "./daily-shared";

type ScheduleInput = {
  readonly kind: "schedule";
  readonly cron: string;
  readonly firedAt: string;
};

const createDaily = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseScheduleInput(ctx.input);
    if (input === null) return [];

    const settings = dailyPathSettings(ctx.extensionConfig);
    const today = localDateParts(new Date(input.firedAt));
    const yesterday = previousLocalDate(today);
    const todayPath = dailyPath(today, settings);
    if ((await ctx.snapshot.readFile(todayPath)) !== null) return [];

    const yesterdayPath = dailyPath(yesterday, settings);
    const yesterdayContent = await ctx.snapshot.readFile(yesterdayPath);
    const yesterdayExists = yesterdayContent !== null;
    const openLoopItems = await collectOpenLoopSourcesForNewDaily({
      ctx,
      targetPath: todayPath,
      settings,
    });
    const skeleton = renderDailySkeleton({
      today,
      yesterday: yesterdayExists ? yesterday : null,
      settings,
    });
    // The unified yesterday block (dome.agent.brief:yesterday) with the
    // mechanical fallback body — the no-model rung of the edition's ladder.
    // A fresh skeleton never carries the block, so the presence-gated ensure
    // always inserts here. See daily-surface §"The one yesterday block".
    const fallbackSection = yesterdayFallbackSection(
      yesterdayContent === null
        ? null
        : previousDailyDigest({
            previousPath: yesterdayPath,
            previousContent: yesterdayContent,
          }),
    );
    const change: FileChangeInput = {
      kind: "write",
      path: todayPath,
      content: replaceOpenLoopSurfaceSection({
        content: ensureYesterdayFallbackSection({
          content: skeleton,
          section: fallbackSection,
        }),
        section: openLoopSurfaceSection({ items: openLoopItems }),
      }),
    };

    return [
      patchEffect({
        mode: "auto",
        changes: [change],
        reason: `dome.daily: create daily note ${todayPath}`,
        sourceRefs: createDailySourceRefs({
          ctx,
          yesterdayExists,
          yesterdayPath,
          openLoopItems,
        }),
      }),
    ];
  },
});

export default createDaily;

async function collectOpenLoopSourcesForNewDaily(input: {
  readonly ctx: ProcessorContext;
  readonly targetPath: string;
  readonly settings: DailyPathSettings;
}): Promise<ReadonlyArray<DailyOpenLoopSource>> {
  const candidates: DailyOpenLoopCandidate[] = [];
  // Attention discounting (task-lifecycle §"Attention discounting"): the new
  // daily's seeded surface applies the same (1 − discount) demotion as
  // carry-forward — the seed order is what retained-merge preserves all day.
  const discounts = await collectAttentionDiscounts({
    snapshot: input.ctx.snapshot,
    settings: input.settings,
  });
  for (const path of await input.ctx.snapshot.listMarkdownFiles()) {
    if (path === input.targetPath) continue;
    const content = await input.ctx.snapshot.readFile(path);
    if (content === null) continue;
    const info = await input.ctx.snapshot.getFileInfo(path);
    for (
      const item of openLoopSurfaceSources({
        path,
        content,
        settings: input.settings,
      })
    ) {
      candidates.push({
        ...item,
        lastChangedAt: attentionAdjustedRecencyIso({
          lastChangedAt: openLoopFreshnessKey({
            path,
            settings: input.settings,
            // Prefer the human-authored timestamp so an engine rewrite (e.g.
            // ^block-anchor stamping) cannot reset open-loop recency.
            lastChangedAt: info?.lastHumanChangedAt ?? info?.lastChangedAt,
          }),
          discount: discounts.get(openLoopIdentity(item))?.discount ?? 0,
        }),
      });
    }
  }
  return rankDailyOpenLoopSurfaceItems(candidates);
}

function createDailySourceRefs(input: {
  readonly ctx: ProcessorContext;
  readonly yesterdayExists: boolean;
  readonly yesterdayPath: string;
  readonly openLoopItems: ReadonlyArray<DailyOpenLoopSource>;
}): ReadonlyArray<SourceRef> {
  const refs: SourceRef[] = [];
  if (input.yesterdayExists) refs.push(input.ctx.sourceRef(input.yesterdayPath));
  for (const item of input.openLoopItems) {
    refs.push(
      input.ctx.sourceRef(item.sourcePath, {
        startLine: item.line,
        endLine: item.line,
      }),
    );
  }
  return Object.freeze(refs);
}

function parseScheduleInput(input: unknown): ScheduleInput | null {
  if (input === null || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  if (record.kind !== "schedule") return null;
  if (typeof record.cron !== "string") return null;
  if (typeof record.firedAt !== "string") return null;
  if (Number.isNaN(new Date(record.firedAt).getTime())) return null;
  return Object.freeze({
    kind: "schedule",
    cron: record.cron,
    firedAt: new Date(record.firedAt).toISOString(),
  });
}
