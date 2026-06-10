// dome.agent.ingest — autonomous knowledge-integration agent for inbox sources.

import { diagnosticEffect, type Effect } from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import {
  dailyPath,
  dailyPathSettings,
  localDateParts,
} from "../../dome.daily/processors/daily-shared";
import { runAgentLoop, type AgentRunState } from "../lib/agent-loop";
import { finishAgentRun } from "../lib/agent-run-effects";
import { coreMemorySection, withCoreMemory } from "../lib/core-memory";
import { makeIngestTools, type CapturedTasksRouting } from "../lib/ingest-tools";
import { INGEST_CHARTER } from "../lib/ingest-charter";

const MAX_STEPS = 25;

const ingest = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    // step is undefined only when NO model provider is wired (doctor's
    // model.provider-missing carries that signal); a text-only provider gets
    // a throwing step from the engine, which fails loudly per source below.
    const step = ctx.modelInvoke?.step;
    if (step === undefined) return Object.freeze([]);

    const rawPaths = ctx.changedPaths.filter(isRawCapturePath);
    if (rawPaths.length === 0) return Object.freeze([]);
    const sourceRefs = rawPaths.map((p) => ctx.sourceRef(p));

    // Today's daily — the captured-tasks landing zone. Same settings-derived
    // path computation as the brief and create-daily (a `daily_path` override
    // in this bundle's config moves it), read once so the task turn and the
    // tool seam can never disagree.
    const settings = dailyPathSettings(ctx.extensionConfig);
    const today = localDateParts(ctx.now());
    const capturedTasks: CapturedTasksRouting = {
      path: dailyPath(today, settings),
      today,
      settings,
    };

    const tools = makeIngestTools({
      reader: {
        readFile: (p) => ctx.snapshot.readFile(p),
        listMarkdownFiles: () => ctx.snapshot.listMarkdownFiles(),
      },
      capturedTasks,
    });

    // Owner core memory: read once per run, prepended to every source's task
    // turn as DATA (never instructions). Absent/empty page → no-op.
    const core = await coreMemorySection({
      readFile: (p) => ctx.snapshot.readFile(p),
      config: ctx.extensionConfig,
    });

    // One accumulator shared across every source in this run. Each source's
    // loop reads prior sources' in-run edits (via the overlay-aware tools) and
    // builds on them, and the whole batch lands as a SINGLE PatchEffect — so
    // there are no racing per-source sub-proposals to clobber a shared page.
    const state: AgentRunState = { edits: new Map(), questions: [] };
    const effects: Effect[] = [];
    if (core.problem !== null) {
      effects.push(
        diagnosticEffect({
          severity: "warning",
          code: "dome.agent.core-config-invalid",
          message: core.problem,
          sourceRefs,
        }),
      );
    }
    let truncated = false;

    for (const sourcePath of rawPaths) {
      const source = await ctx.snapshot.readFile(sourcePath);
      if (source === null) continue;
      try {
        const result = await runAgentLoop({
          charter: INGEST_CHARTER,
          task: withCoreMemory(
            core.section,
            taskTurn(sourcePath, source, capturedTasks.path),
          ),
          tools,
          step,
          maxSteps: MAX_STEPS,
          state,
        });
        if (result.stopReason === "budget") truncated = true;
      } catch (error) {
        // Per-source isolation: a failure on one source must not roll back the
        // sources already accumulated in `state`.
        const message = error instanceof Error ? error.message : String(error);
        effects.push(
          diagnosticEffect({
            severity: "warning",
            code: "dome.agent.source-failed",
            message: `dome.agent: ingest of ${sourcePath} failed (${message}); other sources still applied.`,
            sourceRefs: [ctx.sourceRef(sourcePath)],
          }),
        );
      }
    }

    effects.push(
      ...finishAgentRun({
        state,
        stopReason: truncated ? "budget" : "final",
        sourceRefs,
        patchReason: `dome.agent: ingest ${rawPaths.length} source${rawPaths.length === 1 ? "" : "s"}`,
        truncatedMessage: `dome.agent: ingest hit the ${MAX_STEPS}-step budget before finishing; partial edits were applied.`,
      }),
    );
    return Object.freeze(effects);
  },
});

export default ingest;

function isRawCapturePath(path: string): boolean {
  return /^inbox\/raw\/[^/]+\.md$/.test(path);
}

function taskTurn(
  sourcePath: string,
  source: string,
  todayDailyPath: string,
): string {
  return [
    `Raw source path: ${sourcePath}`,
    `Today's daily note path: ${todayDailyPath}`,
    "",
    "Source content:",
    source,
  ].join("\n");
}
