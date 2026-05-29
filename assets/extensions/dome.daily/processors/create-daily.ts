// dome.daily.create-daily — create today's daily note skeleton.
//
// The scheduled processor only creates the daily page if it is absent.
// Carry-forward is a separate file-created garden processor so manually
// authored daily notes receive the same task rollover behavior.

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

import {
  dailyPath,
  localDateParts,
  previousLocalDate,
  renderDailySkeleton,
} from "./daily-shared";

const DAILY_CRON = "0 6 * * *";

type ScheduleInput = {
  readonly kind: "schedule";
  readonly cron: string;
  readonly firedAt: string;
};

const createDaily: Processor = defineProcessor({
  id: "dome.daily.create-daily",
  version: "0.1.0",
  phase: "garden",
  triggers: [{ kind: "schedule", cron: DAILY_CRON }],
  capabilities: [
    { kind: "read", paths: ["wiki/dailies/*.md"] },
    { kind: "patch.auto", paths: ["wiki/dailies/*.md"] },
  ],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const input = parseScheduleInput(ctx.input);
    if (input === null) return [];

    const today = localDateParts(new Date(input.firedAt));
    const yesterday = previousLocalDate(today);
    const todayPath = dailyPath(today);
    if ((await ctx.snapshot.readFile(todayPath)) !== null) return [];

    const yesterdayPath = dailyPath(yesterday);
    const yesterdayExists = (await ctx.snapshot.readFile(yesterdayPath)) !== null;
    const change: FileChangeInput = {
      kind: "write",
      path: todayPath,
      content: renderDailySkeleton({
        today,
        yesterday: yesterdayExists ? yesterday : null,
      }),
    };

    return [
      patchEffect({
        mode: "auto",
        changes: [change],
        reason: `dome.daily: create daily note ${todayPath}`,
        sourceRefs: yesterdayExists ? [ctx.sourceRef(yesterdayPath)] : [],
      }),
    ];
  },
});

export default createDaily;

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
