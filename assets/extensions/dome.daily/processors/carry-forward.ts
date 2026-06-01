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
  formatDate,
  localDateParts,
  completedSourceBackedOpenLoopsFromMarkdown,
  openLoopIdentity,
  openLoopSurfaceSection,
  openLoopSurfaceSources,
  parseDailyPath,
  replaceOpenLoopSurfaceSection,
  type DailyDate,
  type DailyOpenLoopSource,
  type DailyPathSettings,
  type DailyResolvedOpenLoopSource,
} from "./daily-shared";

const MAX_OPEN_LOOP_SURFACE_ITEMS = 24;

type DailyOpenLoopCandidate = DailyOpenLoopSource & {
  readonly lastChangedAt: string;
};

const carryForward: Processor = defineProcessor({
  id: "dome.daily.carry-forward",
  version: "0.2.0",
  phase: "garden",
  triggers: [
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

    const targetResolvedItems = uniqueResolvedOpenLoops(
      completedSourceBackedOpenLoopsFromMarkdown({
        path: targetPath,
        content,
      }),
    );
    const resolvedIdentities = await collectResolvedOpenLoopIdentities({
      ctx,
      targetPath,
      targetContent: content,
      targetResolvedItems,
    });
    const items = await collectOpenLoopSources({
      ctx,
      targetPath,
      resolvedIdentities,
    });
    const nextContent = replaceOpenLoopSurfaceSection({
      content,
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
        sourceRefs: patchSourceRefs(ctx, items, targetResolvedItems),
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
  readonly resolvedIdentities: ReadonlySet<string>;
}): Promise<ReadonlyArray<DailyOpenLoopSource>> {
  const { ctx, targetPath, resolvedIdentities } = input;
  const items: DailyOpenLoopCandidate[] = [];
  for (const path of await ctx.snapshot.listMarkdownFiles()) {
    if (path === targetPath) continue;
    const content = await ctx.snapshot.readFile(path);
    if (content === null) continue;
    const info = await ctx.snapshot.getFileInfo(path);
    for (const item of openLoopSurfaceSources({ path, content })) {
      if (resolvedIdentities.has(openLoopIdentity(item))) continue;
      items.push({
        ...item,
        lastChangedAt: info?.lastChangedAt ?? "",
      });
    }
  }
  return Object.freeze(dedupeAndSortOpenLoops(items));
}

async function collectResolvedOpenLoopIdentities(input: {
  readonly ctx: ProcessorContext;
  readonly targetPath: string;
  readonly targetContent: string;
  readonly targetResolvedItems: ReadonlyArray<DailyResolvedOpenLoopSource>;
}): Promise<ReadonlySet<string>> {
  const resolved = new Set(
    input.targetResolvedItems.map((item) => openLoopIdentity(item)),
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
      resolved.add(openLoopIdentity(item));
    }
  }
  return resolved;
}

function patchSourceRefs(
  ctx: ProcessorContext,
  items: ReadonlyArray<DailyOpenLoopSource>,
  resolvedItems: ReadonlyArray<DailyResolvedOpenLoopSource>,
): ReadonlyArray<SourceRef> {
  return [
    ...items.map((item) =>
      ctx.sourceRef(item.sourcePath, {
        startLine: item.line,
        endLine: item.line,
      })
    ),
    ...resolvedItems.map((item) =>
      ctx.sourceRef(item.path, {
        startLine: item.line,
        endLine: item.line,
      })
    ),
  ];
}

function dedupeAndSortOpenLoops(
  items: ReadonlyArray<DailyOpenLoopCandidate>,
): ReadonlyArray<DailyOpenLoopSource> {
  const seen = new Set<string>();
  const out: DailyOpenLoopSource[] = [];
  for (const item of [...items].sort(compareOpenLoopSources)) {
    const key = normalizedOpenLoopKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(stripCandidateMetadata(item));
    if (out.length >= MAX_OPEN_LOOP_SURFACE_ITEMS) break;
  }
  return Object.freeze(out);
}

function normalizedOpenLoopKey(item: DailyOpenLoopSource): string {
  return openLoopIdentity(item);
}

function compareDailyDates(a: DailyDate, b: DailyDate): number {
  return formatDate(a).localeCompare(formatDate(b));
}

function compareOpenLoopSources(
  a: DailyOpenLoopCandidate,
  b: DailyOpenLoopCandidate,
): number {
  const changedCmp = b.lastChangedAt.localeCompare(a.lastChangedAt);
  if (changedCmp !== 0) return changedCmp;
  const pathCmp = a.sourcePath.localeCompare(b.sourcePath);
  if (pathCmp !== 0) return pathCmp;
  const lineCmp = a.line - b.line;
  if (lineCmp !== 0) return lineCmp;
  return a.body.localeCompare(b.body);
}

function stripCandidateMetadata(
  item: DailyOpenLoopCandidate,
): DailyOpenLoopSource {
  return Object.freeze({
    line: item.line,
    body: item.body,
    followup: item.followup,
    sourcePath: item.sourcePath,
  });
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
