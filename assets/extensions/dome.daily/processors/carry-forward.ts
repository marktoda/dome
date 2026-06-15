// dome.daily.carry-forward — raise source-backed open loops into the daily.
//
// The processor reacts to daily creation and markdown changes, scans the
// readable vault for explicit action items, and replaces a small stable
// generated section in the current daily note. The historical processor id is
// preserved because this is an evolution of the carry-forward loop, not a new
// runtime primitive.

import {
  patchEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../src/core/effect";
import { generatedBlockAnomalyDiagnostics } from "../../../../src/core/generated-block-diagnostics";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";

import {
  attentionAdjustedRecencyIso,
  collectAttentionDiscounts,
} from "./attention-shared";
import {
  dailyPath,
  dailyPathSettings,
  localDateParts,
  parseScheduleInput,
  previousLocalDate,
} from "./daily-paths";
import {
  ensureYesterdayFallbackSection,
  previousDailyDigest,
  removeLegacyStartContextSection,
  yesterdayFallbackSection,
} from "./daily-scaffold";
import {
  DAILY_GENERATED_BLOCKS,
  type DailyDate,
  type DailyOpenLoopCandidate,
  type DailyOpenLoopSource,
  type DailyPathSettings,
  type DailySettledOpenLoopSource,
} from "./daily-types";
import {
  openLoopFreshnessKey,
  openLoopIdentity,
  openLoopSurfaceKey,
  openLoopSurfaceSection,
  openLoopSurfaceSources,
  openSourceBackedOpenLoopsFromMarkdown,
  rankDailyOpenLoopSurfaceItems,
  replaceOpenLoopSurfaceSection,
  settledSourceBackedOpenLoopsFromMarkdown,
} from "./open-loop-surface";

const OPEN_LOOP_SURFACE_LIMIT = 12;

const carryForward = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const settings = dailyPathSettings(ctx.extensionConfig);
    const targetDate = targetDailyDate(ctx);
    const targetPath = dailyPath(targetDate, settings);
    const content = await ctx.snapshot.readFile(targetPath);
    if (content === null) return [];

    // Marker anomalies in the (human-editable) daily note — smuggled
    // duplicate pairs, half-open markers — are ignored by the line-anchored
    // splice below but surfaced as info diagnostics so the attempt is
    // visible (dedup at the diagnostics sink keeps re-runs quiet).
    const anomalyDiagnostics = generatedBlockAnomalyDiagnostics({
      content,
      path: targetPath,
      code: "dome.daily.generated-block-anomaly",
      blocks: DAILY_GENERATED_BLOCKS,
      sourceRef: (path, range) => ctx.sourceRef(path, range),
    });

    const fallback = await collectYesterdayFallback({
      ctx,
      targetDate,
      settings,
    });

    const targetSettledItems = uniqueBy(
      settledSourceBackedOpenLoopsFromMarkdown({
        path: targetPath,
        content,
      }),
      openLoopIdentity,
    );
    const targetOpenItems = uniqueBy(
      openSourceBackedOpenLoopsFromMarkdown({
        path: targetPath,
        content,
      }),
      openLoopIdentity,
    );
    const settledKeys = await collectSettledOpenLoopIdentities({
      ctx,
      targetPath,
      targetContent: content,
      targetSettledItems,
    });
    const items = await collectOpenLoopSources({
      ctx,
      targetPath,
      settings,
      targetOpenItems,
      settledKeys,
    });
    // Migration (one-time, idempotent): drop a legacy dome.daily:start-context
    // block from TODAY's daily in the same patch that ensures the unified
    // yesterday block. Historical dailies are never targeted by this
    // processor, so they keep theirs. The yesterday ensure is presence-gated:
    // an existing block (curated by the brief, or a previously seeded
    // fallback) is left alone entirely.
    const nextContent = replaceOpenLoopSurfaceSection({
      content: ensureYesterdayFallbackSection({
        content: removeLegacyStartContextSection(content),
        section: fallback.section,
      }),
      section: openLoopSurfaceSection({
        items,
        settledItems: targetSettledItems,
      }),
    });
    if (nextContent === content) return Object.freeze([...anomalyDiagnostics]);

    const change: FileChangeInput = {
      kind: "write",
      path: targetPath,
      content: nextContent,
    };

    return [
      ...anomalyDiagnostics,
      patchEffect({
        mode: "auto",
        changes: [change],
        reason: `dome.daily: raise source-backed open loops into ${targetPath}`,
        sourceRefs: patchSourceRefs(
          ctx,
          items,
          targetSettledItems,
          fallback.sourcePath,
        ),
      }),
    ];
  },
});

export default carryForward;

function targetDailyDate(ctx: ProcessorContext): DailyDate {
  const scheduled = parseScheduleInput(ctx.input);
  return localDateParts(
    scheduled === null ? ctx.now() : new Date(scheduled.firedAt),
  );
}

async function collectOpenLoopSources(input: {
  readonly ctx: ProcessorContext;
  readonly targetPath: string;
  readonly settings: DailyPathSettings;
  readonly targetOpenItems: ReadonlyArray<DailyOpenLoopSource>;
  readonly settledKeys: SettledOpenLoopKeys;
}): Promise<ReadonlyArray<DailyOpenLoopSource>> {
  const { ctx, targetPath, settings, targetOpenItems, settledKeys } = input;
  const items: DailyOpenLoopCandidate[] = [];
  const itemByIdentity = new Map<string, DailyOpenLoopCandidate>();
  // Attention discounting (task-lifecycle §"Attention discounting"): items
  // surfaced repeatedly without action rank as if their last human change
  // were log(1−d)/log(0.995) hours older. Demotion reorders within the same
  // ranked list — it never filters an item out.
  const discounts = await collectAttentionDiscounts({
    snapshot: ctx.snapshot,
    settings,
  });
  for (const path of await ctx.snapshot.listMarkdownFiles()) {
    if (path === targetPath) continue;
    const content = await ctx.snapshot.readFile(path);
    if (content === null) continue;
    const info = await ctx.snapshot.getFileInfo(path);
    for (const item of openLoopSurfaceSources({ path, content, settings })) {
      if (
        settledKeys.identities.has(openLoopIdentity(item)) ||
        settledKeys.surfaceKeys.has(openLoopSurfaceKey(item))
      ) {
        continue;
      }
      const candidate: DailyOpenLoopCandidate = {
        ...item,
        lastChangedAt: attentionAdjustedRecencyIso({
          lastChangedAt: openLoopFreshnessKey({
            path,
            settings,
            // Prefer the human-authored timestamp so an engine rewrite (e.g.
            // ^block-anchor stamping) cannot reset open-loop recency.
            lastChangedAt: info?.lastHumanChangedAt ?? info?.lastChangedAt,
          }),
          discount: discounts.get(openLoopIdentity(item))?.discount ?? 0,
        }),
      };
      items.push(candidate);
      itemByIdentity.set(openLoopIdentity(candidate), candidate);
    }
  }
  return mergeRetainedOpenLoops({
    retainedItems: targetOpenItems,
    itemByIdentity,
    rankedItems: rankDailyOpenLoopSurfaceItems(items, OPEN_LOOP_SURFACE_LIMIT),
  });
}

async function collectYesterdayFallback(input: {
  readonly ctx: ProcessorContext;
  readonly targetDate: DailyDate;
  readonly settings: DailyPathSettings;
}): Promise<{
  readonly section: string;
  readonly sourcePath: string | null;
}> {
  const previous = previousLocalDate(input.targetDate);
  const previousPath = dailyPath(previous, input.settings);
  const previousContent = await input.ctx.snapshot.readFile(previousPath);
  if (previousContent === null) {
    // No previous daily: the fallback degrades to the single
    // "no record of yesterday" line — never an absent block.
    return Object.freeze({
      section: yesterdayFallbackSection(null),
      sourcePath: null,
    });
  }
  return Object.freeze({
    section: yesterdayFallbackSection(
      previousDailyDigest({
        previousPath,
        previousContent,
      }),
    ),
    sourcePath: previousPath,
  });
}

async function collectSettledOpenLoopIdentities(input: {
  readonly ctx: ProcessorContext;
  readonly targetPath: string;
  readonly targetContent: string;
  readonly targetSettledItems: ReadonlyArray<DailySettledOpenLoopSource>;
}): Promise<SettledOpenLoopKeys> {
  const identities = new Set(
    input.targetSettledItems.map((item) => openLoopIdentity(item)),
  );
  const surfaceKeys = new Set(
    input.targetSettledItems.map((item) => openLoopSurfaceKey(item)),
  );
  for (const path of await input.ctx.snapshot.listMarkdownFiles()) {
    const content =
      path === input.targetPath
        ? input.targetContent
        : await input.ctx.snapshot.readFile(path);
    if (content === null) continue;
    for (const item of settledSourceBackedOpenLoopsFromMarkdown({
      path,
      content,
    })) {
      identities.add(openLoopIdentity(item));
      surfaceKeys.add(openLoopSurfaceKey(item));
    }
  }
  return Object.freeze({
    identities,
    surfaceKeys,
  });
}

type SettledOpenLoopKeys = {
  readonly identities: ReadonlySet<string>;
  readonly surfaceKeys: ReadonlySet<string>;
};

function mergeRetainedOpenLoops(input: {
  readonly retainedItems: ReadonlyArray<DailyOpenLoopSource>;
  readonly itemByIdentity: ReadonlyMap<string, DailyOpenLoopCandidate>;
  readonly rankedItems: ReadonlyArray<DailyOpenLoopSource>;
}): ReadonlyArray<DailyOpenLoopSource> {
  const out: DailyOpenLoopSource[] = [];
  const identities = new Set<string>();
  const surfaceKeys = new Set<string>();

  const append = (item: DailyOpenLoopSource): void => {
    if (out.length >= OPEN_LOOP_SURFACE_LIMIT) return;
    const identity = openLoopIdentity(item);
    if (identities.has(identity)) return;
    const surfaceKey = openLoopSurfaceKey(item);
    if (surfaceKeys.has(surfaceKey)) return;
    identities.add(identity);
    surfaceKeys.add(surfaceKey);
    out.push(item);
  };

  for (const retained of input.retainedItems) {
    const live = input.itemByIdentity.get(openLoopIdentity(retained));
    if (live !== undefined) append(live);
  }
  for (const ranked of input.rankedItems) append(ranked);

  return Object.freeze(out);
}

function patchSourceRefs(
  ctx: ProcessorContext,
  items: ReadonlyArray<DailyOpenLoopSource>,
  settledItems: ReadonlyArray<DailySettledOpenLoopSource>,
  startContextSourcePath: string | null,
): ReadonlyArray<SourceRef> {
  return [
    ...(startContextSourcePath === null
      ? []
      : [ctx.sourceRef(startContextSourcePath)]),
    ...items.map((item) =>
      ctx.sourceRef(
        item.sourcePath,
        {
          startLine: item.line,
          endLine: item.line,
        },
        item.stableId,
      )
    ),
    ...settledItems.map((item) =>
      ctx.sourceRef(
        item.path,
        {
          startLine: item.line,
          endLine: item.line,
        },
        item.stableId,
      )
    ),
  ];
}

// First-seen dedup over an arbitrary identity key. A Set preserves insertion
// order, so the survivor of each identity is the first occurrence — matching
// the two former twin helpers (uniqueOpenLoops / uniqueSettledOpenLoops) this
// replaced, both of which keyed on openLoopIdentity.
function uniqueBy<T>(
  items: ReadonlyArray<T>,
  key: (t: T) => string,
): ReadonlyArray<T> {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return Object.freeze(out);
}
