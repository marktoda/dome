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
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";

import {
  dailyPathSettings,
  dailyPath,
  dailyStartContextSection,
  localDateParts,
  openLoopIdentity,
  openLoopFreshnessKey,
  openSourceBackedOpenLoopsFromMarkdown,
  openLoopSurfaceKey,
  openLoopSurfaceSection,
  openLoopSurfaceSources,
  previousDailyStartContext,
  previousLocalDate,
  rankDailyOpenLoopSurfaceItems,
  replaceDailyStartContextSection,
  replaceOpenLoopSurfaceSection,
  settledSourceBackedOpenLoopsFromMarkdown,
  type DailyDate,
  type DailyOpenLoopCandidate,
  type DailyOpenLoopSource,
  type DailyPathSettings,
  type DailySettledOpenLoopSource,
} from "./daily-shared";

const OPEN_LOOP_SURFACE_LIMIT = 12;

const carryForward = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const settings = dailyPathSettings(ctx.extensionConfig);
    const targetDate = targetDailyDate(ctx);
    const targetPath = dailyPath(targetDate, settings);
    const content = await ctx.snapshot.readFile(targetPath);
    if (content === null) return [];
    const startContext = await collectStartContext({
      ctx,
      targetDate,
      settings,
    });

    const targetSettledItems = uniqueSettledOpenLoops(
      settledSourceBackedOpenLoopsFromMarkdown({
        path: targetPath,
        content,
      }),
    );
    const targetOpenItems = uniqueOpenLoops(
      openSourceBackedOpenLoopsFromMarkdown({
        path: targetPath,
        content,
      }),
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
    const nextContent = replaceOpenLoopSurfaceSection({
      content: replaceDailyStartContextSection({
        content,
        section: startContext.section,
      }),
      section: openLoopSurfaceSection({
        items,
        settledItems: targetSettledItems,
      }),
    });
    if (nextContent === content) return [];

    const change: FileChangeInput = {
      kind: "write",
      path: targetPath,
      content: nextContent,
    };

    return [
      patchEffect({
        mode: "auto",
        changes: [change],
        reason: `dome.daily: raise source-backed open loops into ${targetPath}`,
        sourceRefs: patchSourceRefs(
          ctx,
          items,
          targetSettledItems,
          startContext.sourcePath,
        ),
      }),
    ];
  },
});

export default carryForward;

type ScheduleInput = {
  readonly kind: "schedule";
  readonly cron: string;
  readonly firedAt: string;
};

function targetDailyDate(ctx: ProcessorContext): DailyDate {
  const scheduled = parseScheduleInput(ctx.input);
  return localDateParts(
    scheduled === null ? ctx.now() : new Date(scheduled.firedAt),
  );
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
        lastChangedAt: openLoopFreshnessKey({
          path,
          settings,
          lastChangedAt: info?.lastChangedAt,
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

async function collectStartContext(input: {
  readonly ctx: ProcessorContext;
  readonly targetDate: DailyDate;
  readonly settings: DailyPathSettings;
}): Promise<{
  readonly section: string | null;
  readonly sourcePath: string | null;
}> {
  const previous = previousLocalDate(input.targetDate);
  const previousPath = dailyPath(previous, input.settings);
  const previousContent = await input.ctx.snapshot.readFile(previousPath);
  if (previousContent === null) {
    return Object.freeze({ section: null, sourcePath: null });
  }
  return Object.freeze({
    section: dailyStartContextSection(
      previousDailyStartContext({
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

function uniqueSettledOpenLoops(
  items: ReadonlyArray<DailySettledOpenLoopSource>,
): ReadonlyArray<DailySettledOpenLoopSource> {
  const seen = new Set<string>();
  const out: DailySettledOpenLoopSource[] = [];
  for (const item of items) {
    const key = openLoopIdentity(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return Object.freeze(out);
}

function uniqueOpenLoops(
  items: ReadonlyArray<DailyOpenLoopSource>,
): ReadonlyArray<DailyOpenLoopSource> {
  const seen = new Set<string>();
  const out: DailyOpenLoopSource[] = [];
  for (const item of items) {
    const key = openLoopIdentity(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return Object.freeze(out);
}
