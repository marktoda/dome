// dome.agent.consolidate — weekly vault-janitor agent: merge duplicate pages
// + tidy within-page append-drift. One agent loop per scheduled tick; its
// edits accumulate in one AgentRunState (overlay reads compose successive
// merges + link rewrites) and land as a single cumulative PatchEffect.

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
import { makeConsolidatorTools } from "../lib/consolidate-tools";
import { CONSOLIDATE_CHARTER } from "../lib/consolidate-charter";

const MAX_STEPS = 50;
const LEDGER_PATH = "consolidation-ledger.md";

const consolidate = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const step = ctx.modelInvoke?.step;
    if (step === undefined) return Object.freeze([]); // clean no-op without a model

    const tools = makeConsolidatorTools({
      reader: {
        readFile: (p) => ctx.snapshot.readFile(p),
        listMarkdownFiles: () => ctx.snapshot.listMarkdownFiles(),
      },
    });

    const state: AgentRunState = { edits: new Map(), questions: [] };
    const effects: Effect[] = [];
    let truncated = false;
    try {
      const result = await runAgentLoop({
        charter: CONSOLIDATE_CHARTER,
        task: taskTurn(ctx.now()),
        tools,
        step,
        maxSteps: MAX_STEPS,
        state,
      });
      if (result.stopReason === "budget") truncated = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      effects.push(
        diagnosticEffect({
          severity: "warning",
          code: "dome.agent.consolidate-failed",
          message: `dome.agent.consolidate failed (${message}); no edits applied.`,
          sourceRefs: [ctx.sourceRef(LEDGER_PATH)],
        }),
      );
    }

    const sourceRefs = [ctx.sourceRef(LEDGER_PATH)];
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
          reason: "dome.agent: consolidate vault",
          sourceRefs,
        }),
      );
    }
    for (const q of state.questions) {
      effects.push(
        questionEffect({ question: q.question, idempotencyKey: q.idempotencyKey, sourceRefs }),
      );
    }
    if (truncated) {
      effects.push(
        diagnosticEffect({
          severity: "warning",
          code: "dome.agent.truncated",
          message: `dome.agent.consolidate hit the ${MAX_STEPS}-step budget; partial cleanup applied, resume next run.`,
          sourceRefs,
        }),
      );
    }
    return Object.freeze(effects);
  },
});

export default consolidate;

function taskTurn(now: Date): string {
  const today = now.toISOString().slice(0, 10);
  return [
    `Today is ${today}. Consolidate the vault per your charter.`,
    "Start by reading index.md, log.md, and consolidation-ledger.md.",
    "Do a bounded batch of merges + within-page tidies, then update the ledger.",
  ].join("\n");
}
