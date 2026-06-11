// Shared daily-surface evidence extraction for dome.search packets.
//
// Daily-intent search packets are still search surfaces, not daily processors.
// They read already-recalled daily files and expose the cockpit rows as
// source-backed overview evidence for foreground agents.

import type { ProcessorContext } from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";
import { actionItemsFromMarkdown } from "../../dome.daily/processors/action-extraction";
import { type MarkdownActionItem, type DailyOpenLoopSource } from "../../dome.daily/processors/daily-types";
import {
  openLoopStableId,
  openLoopSurfaceKey,
  openSourceBackedOpenLoopsFromMarkdown,
} from "../../dome.daily/processors/open-loop-surface";
import { searchDailyActionLabel } from "./labels";
import { uniqueSourceRefs } from "./related";
import type { SearchRecallSignal } from "./recall";

import { compareStrings } from "../../../../src/core/compare";

const DEFAULT_MAX_DAILY_SURFACE_PATHS = 3;

export type DailySurfaceContextOpenLoop = {
  readonly path: string;
  readonly predicate: string;
  readonly text: string;
  readonly sourceRefs: ReadonlyArray<SourceRef>;
};

export async function dailySurfaceOpenLoopsForContext(input: {
  readonly ctx: ProcessorContext;
  readonly recallSignalsByPath: ReadonlyMap<
    string,
    ReadonlyArray<SearchRecallSignal>
  >;
  readonly maxRows: number;
  readonly maxPaths?: number;
}): Promise<ReadonlyArray<DailySurfaceContextOpenLoop>> {
  const paths = dailySurfacePaths(
    input.recallSignalsByPath,
    input.maxPaths ?? DEFAULT_MAX_DAILY_SURFACE_PATHS,
  );
  const out: DailySurfaceContextOpenLoop[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const content = await input.ctx.snapshot.readFile(path);
    if (content === null) continue;
    const items = dailySurfaceActionItems(path, content);
    for (const item of items) {
      const loop = contextOpenLoopFromDailySurfaceItem(input.ctx, path, item);
      const key = dailySurfaceOpenLoopKey(loop);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(loop);
      if (out.length >= input.maxRows) return Object.freeze(out);
    }
  }
  return Object.freeze(out);
}

function dailySurfacePaths(
  recallSignalsByPath: ReadonlyMap<string, ReadonlyArray<SearchRecallSignal>>,
  maxPaths: number,
): ReadonlyArray<string> {
  return Object.freeze(
    [...recallSignalsByPath.entries()]
      .filter(([, signals]) => signals.some((signal) => signal.kind === "daily"))
      .sort((a, b) => {
        const weightCmp = maxDailySignalWeight(b[1]) -
          maxDailySignalWeight(a[1]);
        return weightCmp !== 0 ? weightCmp : compareStrings(a[0], b[0]);
      })
      .map(([path]) => path)
      .slice(0, maxPaths),
  );
}

function maxDailySignalWeight(
  signals: ReadonlyArray<SearchRecallSignal>,
): number {
  return signals
    .filter((signal) => signal.kind === "daily")
    .reduce((max, signal) => Math.max(max, signal.weight), 0);
}

type DailySurfaceActionItem = DailyOpenLoopSource & {
  readonly sourceBacked: boolean;
};

function dailySurfaceActionItems(
  path: string,
  content: string,
): ReadonlyArray<DailySurfaceActionItem> {
  const sourceBacked = openSourceBackedOpenLoopsFromMarkdown({
    path,
    content,
  }).map((item) =>
    Object.freeze({
      ...item,
      sourceBacked: true,
    })
  );
  const direct = actionItemsFromMarkdown(content).map((item) =>
    dailySurfaceActionItemFromMarkdownItem(path, item)
  );
  return Object.freeze(
    [...sourceBacked, ...direct].sort((a, b) =>
      a.line - b.line || compareStrings(a.body, b.body)
    ),
  );
}

function dailySurfaceActionItemFromMarkdownItem(
  path: string,
  item: MarkdownActionItem,
): DailySurfaceActionItem {
  return Object.freeze({
    line: item.line,
    stableId: openLoopStableId({ sourcePath: path, body: item.body }),
    body: item.body,
    followup: item.followup,
    sourcePath: path,
    sourceBacked: false,
  });
}

function contextOpenLoopFromDailySurfaceItem(
  ctx: ProcessorContext,
  path: string,
  item: DailySurfaceActionItem,
): DailySurfaceContextOpenLoop {
  const surfaceRef = ctx.sourceRef(
    path,
    { startLine: item.line, endLine: item.line },
    item.stableId,
  );
  const sourceRefs = uniqueSourceRefs([
    surfaceRef,
    ...(item.sourceBacked && item.sourcePath !== path
      ? [ctx.sourceRef(item.sourcePath, undefined, item.stableId)]
      : []),
  ]);
  return Object.freeze({
    path,
    predicate: item.followup
      ? "dome.daily.followup"
      : "dome.daily.open_task",
    text: searchDailyActionLabel(item.body),
    sourceRefs,
  });
}

function dailySurfaceOpenLoopKey(
  item: DailySurfaceContextOpenLoop,
): string {
  return [
    item.predicate,
    openLoopSurfaceKey({ body: item.text }),
  ].join("\u0000");
}
