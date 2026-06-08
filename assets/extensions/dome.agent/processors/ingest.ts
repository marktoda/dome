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
import { runAgentLoop } from "../lib/agent-loop";
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

    const effects: Effect[] = [];
    for (const sourcePath of rawPaths) {
      const source = await ctx.snapshot.readFile(sourcePath);
      if (source === null) continue;

      const result = await runAgentLoop({
        charter: INGEST_CHARTER,
        task: taskTurn(sourcePath, source, ctx.now()),
        tools,
        step,
        maxSteps: MAX_STEPS,
      });

      const changes = [...result.state.edits.values()].map((e) =>
        e.kind === "write"
          ? ({ kind: "write", path: e.path, content: e.content } as const)
          : ({ kind: "delete", path: e.path } as const),
      );
      if (changes.length > 0) {
        effects.push(
          patchEffect({
            mode: "auto",
            changes,
            reason: `dome.agent: ingest ${sourcePath}`,
            sourceRefs: [ctx.sourceRef(sourcePath)],
          }),
        );
      }
      for (const q of result.state.questions) {
        effects.push(
          questionEffect({
            question: q.question,
            idempotencyKey: q.idempotencyKey,
            sourceRefs: [ctx.sourceRef(sourcePath)],
          }),
        );
      }
      if (result.stopReason === "budget") {
        effects.push(
          diagnosticEffect({
            severity: "warning",
            code: "dome.agent.truncated",
            message: `dome.agent: ingest of ${sourcePath} hit the ${MAX_STEPS}-step budget before finishing; partial edits were applied.`,
            sourceRefs: [ctx.sourceRef(sourcePath)],
          }),
        );
      }
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
