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
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";

import {
  dailyPathSettings,
  dailyPath,
  dailyStartContextSection,
  formatDate,
  localDateParts,
  completedSourceBackedOpenLoopsFromMarkdown,
  openLoopIdentity,
  openLoopSurfaceKey,
  openLoopSurfaceSection,
  openLoopSurfaceSources,
  parseDailyPath,
  previousDailyStartContext,
  previousLocalDate,
  rankDailyOpenLoopSurfaceItems,
  replaceDailyStartContextSection,
  replaceOpenLoopSurfaceSection,
  type DailyDate,
  type DailyOpenLoopCandidate,
  type DailyOpenLoopSource,
  type DailyPathSettings,
  type DailyResolvedOpenLoopSource,
} from "./daily-shared";

const DAILY_CRON = "0 6 * * *";

const carryForward: Processor = defineProcessor({
  id: "dome.daily.carry-forward",
  version: "0.2.4",
  phase: "garden",
  triggers: [
    { kind: "schedule", cron: DAILY_CRON },
    {
      kind: "signal",
      name: "file.created",
      pathPattern: "wiki/**/*.md",
    },
    {
      kind: "signal",
      name: "document.changed",
      pathPattern: "wiki/**/*.md",
    },
    {
      kind: "signal",
      name: "file.created",
      pathPattern: "notes/*.md",
    },
    {
      kind: "signal",
      name: "document.changed",
      pathPattern: "notes/*.md",
    },
    {
      kind: "signal",
      name: "file.deleted",
      pathPattern: "wiki/**/*.md",
    },
    {
      kind: "signal",
      name: "file.deleted",
      pathPattern: "notes/*.md",
    },
  ],
  capabilities: [
    { kind: "read", paths: ["wiki/**/*.md", "notes/*.md"] },
    { kind: "patch.auto", paths: ["wiki/dailies/*.md", "notes/*.md"] },
  ],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const settings = dailyPathSettings(ctx.extensionConfig);
    const targetDate = await targetDailyDate(ctx, settings);
    const targetPath = dailyPath(targetDate, settings);
    const content = await ctx.snapshot.readFile(targetPath);
    if (content === null) return [];
    const startContext = await collectStartContext({
      ctx,
      targetDate,
      settings,
    });

    const targetResolvedItems = uniqueResolvedOpenLoops(
      completedSourceBackedOpenLoopsFromMarkdown({
        path: targetPath,
        content,
      }),
    );
    const resolvedKeys = await collectResolvedOpenLoopIdentities({
      ctx,
      targetPath,
      targetContent: content,
      targetResolvedItems,
    });
    const items = await collectOpenLoopSources({
      ctx,
      targetPath,
      settings,
      resolvedKeys,
    });
    const nextContent = replaceOpenLoopSurfaceSection({
      content: replaceDailyStartContextSection({
        content,
        section: startContext.section,
      }),
      section: openLoopSurfaceSection({
        items,
        resolvedItems: targetResolvedItems,
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
          targetResolvedItems,
          startContext.sourcePath,
        ),
      }),
    ];
  },
});

export default carryForward;

async function targetDailyDate(
  ctx: ProcessorContext,
  settings: DailyPathSettings,
): Promise<DailyDate> {
  const changedDailyDates = ctx.changedPaths
    .map((path) => parseDailyPath(path, settings))
    .filter((date): date is DailyDate => date !== null)
    .sort(compareDailyDates);
  const changedDate = changedDailyDates.at(-1);
  if (changedDate !== undefined) return changedDate;

  const existingDailyDates = (await ctx.snapshot.listMarkdownFiles())
    .map((path) => parseDailyPath(path, settings))
    .filter((date): date is DailyDate => date !== null)
    .sort(compareDailyDates);
  return existingDailyDates.at(-1) ?? localDateParts(new Date());
}

async function collectOpenLoopSources(input: {
  readonly ctx: ProcessorContext;
  readonly targetPath: string;
  readonly settings: DailyPathSettings;
  readonly resolvedKeys: ResolvedOpenLoopKeys;
}): Promise<ReadonlyArray<DailyOpenLoopSource>> {
  const { ctx, targetPath, settings, resolvedKeys } = input;
  const items: DailyOpenLoopCandidate[] = [];
  for (const path of await ctx.snapshot.listMarkdownFiles()) {
    if (path === targetPath) continue;
    const content = await ctx.snapshot.readFile(path);
    if (content === null) continue;
    const info = await ctx.snapshot.getFileInfo(path);
    for (const item of openLoopSurfaceSources({ path, content, settings })) {
      if (
        resolvedKeys.identities.has(openLoopIdentity(item)) ||
        resolvedKeys.surfaceKeys.has(openLoopSurfaceKey(item))
      ) {
        continue;
      }
      items.push({
        ...item,
        lastChangedAt: info?.lastChangedAt ?? "",
      });
    }
  }
  return rankDailyOpenLoopSurfaceItems(items);
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

async function collectResolvedOpenLoopIdentities(input: {
  readonly ctx: ProcessorContext;
  readonly targetPath: string;
  readonly targetContent: string;
  readonly targetResolvedItems: ReadonlyArray<DailyResolvedOpenLoopSource>;
}): Promise<ResolvedOpenLoopKeys> {
  const identities = new Set(
    input.targetResolvedItems.map((item) => openLoopIdentity(item)),
  );
  const surfaceKeys = new Set(
    input.targetResolvedItems.map((item) => openLoopSurfaceKey(item)),
  );
  for (const path of await input.ctx.snapshot.listMarkdownFiles()) {
    const content =
      path === input.targetPath
        ? input.targetContent
        : await input.ctx.snapshot.readFile(path);
    if (content === null) continue;
    for (const item of completedSourceBackedOpenLoopsFromMarkdown({
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

type ResolvedOpenLoopKeys = {
  readonly identities: ReadonlySet<string>;
  readonly surfaceKeys: ReadonlySet<string>;
};

function patchSourceRefs(
  ctx: ProcessorContext,
  items: ReadonlyArray<DailyOpenLoopSource>,
  resolvedItems: ReadonlyArray<DailyResolvedOpenLoopSource>,
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
    ...resolvedItems.map((item) =>
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

function compareDailyDates(a: DailyDate, b: DailyDate): number {
  return formatDate(a).localeCompare(formatDate(b));
}

function uniqueResolvedOpenLoops(
  items: ReadonlyArray<DailyResolvedOpenLoopSource>,
): ReadonlyArray<DailyResolvedOpenLoopSource> {
  const seen = new Set<string>();
  const out: DailyResolvedOpenLoopSource[] = [];
  for (const item of items) {
    const key = openLoopIdentity(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return Object.freeze(out);
}
