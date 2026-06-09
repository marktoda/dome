// dome.agent.ingest — autonomous knowledge-integration agent for inbox sources.

import {
  diagnosticEffect,
  patchEffect,
  questionEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { runAgentLoop, type AgentRunState } from "../lib/agent-loop";
import { makeIngestTools } from "../lib/ingest-tools";
import { INGEST_CHARTER } from "../lib/ingest-charter";

const MAX_STEPS = 25;

const ingest = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const step = ctx.modelInvoke?.step;
    if (step === undefined) return Object.freeze([]); // clean no-op without a model

    const rawPaths = ctx.changedPaths.filter(isRawCapturePath);
    if (rawPaths.length === 0) return Object.freeze([]);

    const tools = makeIngestTools({
      reader: {
        readFile: (p) => ctx.snapshot.readFile(p),
        listMarkdownFiles: () => ctx.snapshot.listMarkdownFiles(),
      },
    });

    // One accumulator shared across every source in this run. Each source's
    // loop reads prior sources' in-run edits (via the overlay-aware tools) and
    // builds on them, and the whole batch lands as a SINGLE PatchEffect — so
    // there are no racing per-source sub-proposals to clobber a shared page.
    const state: AgentRunState = { edits: new Map(), questions: [] };
    const effects: Effect[] = [];
    let truncated = false;

    for (const sourcePath of rawPaths) {
      const source = await ctx.snapshot.readFile(sourcePath);
      if (source === null) continue;
      try {
        const result = await runAgentLoop({
          charter: INGEST_CHARTER,
          task: taskTurn(sourcePath, source, ctx.now()),
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

    const sourceRefs = rawPaths.map((p) => ctx.sourceRef(p));
    const changes = [...state.edits.values()].map((e) =>
      e.kind === "write"
        ? ({ kind: "write", path: e.path, content: e.content } as const)
        : ({ kind: "delete", path: e.path } as const),
    );
    if (changes.length > 0) {
      effects.push(
        patchEffect({
          mode: "auto",
          changes,
          reason: `dome.agent: ingest ${rawPaths.length} source${rawPaths.length === 1 ? "" : "s"}`,
          sourceRefs,
        }),
      );
    }
    for (const q of state.questions) {
      effects.push(
        questionEffect({
          question: q.question,
          idempotencyKey: q.idempotencyKey,
          sourceRefs,
        }),
      );
    }
    if (truncated) {
      effects.push(
        diagnosticEffect({
          severity: "warning",
          code: "dome.agent.truncated",
          message: `dome.agent: ingest hit the ${MAX_STEPS}-step budget before finishing; partial edits were applied.`,
          sourceRefs,
        }),
      );
    }
    return Object.freeze(effects);
  },
});

export default ingest;

function isRawCapturePath(path: string): boolean {
  return /^inbox\/raw\/[^/]+\.md$/.test(path);
}

function taskTurn(sourcePath: string, source: string, now: Date): string {
  const today = now.toISOString().slice(0, 10);
  return [
    `Raw source path: ${sourcePath}`,
    `Today's daily note path: notes/${today}.md`,
    "",
    "Source content:",
    source,
  ].join("\n");
}
