// test.compose-question.ask — harness fixture-bundle processor.
//
// Garden-phase processor that asks one durable question when `queue/ask.md`
// is created. Its `recordQuestion` sink write is the emit point that sets the
// host tick's questions-changed flag, driving the epilogue dispatch of the
// real `dome.daily.compose-blocks` compositor (a `questions.changed`
// subscriber). The trigger path lives outside `wiki/` and `notes/` so no
// dome.daily garden processor reacts to it — the fixture's question is the
// only one in the projection, keeping the end-to-end assertion deterministic.

import {
  questionEffect,
  type Effect,
} from "../../../../../../src/core/effect";
import { defineProcessor } from "../../../../../../src/core/processor";

const ASK_PATH = "queue/ask.md";

export default defineProcessor({
  id: "test.compose-question.ask",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    {
      kind: "signal",
      name: "file.created",
      pathPattern: ASK_PATH,
    },
  ],
  capabilities: [{ kind: "read", paths: [ASK_PATH] }, { kind: "question.ask" }],
  async run(ctx): Promise<Effect[]> {
    return [
      questionEffect({
        question: "test.compose-question: ship the pricing change?",
        options: ["yes", "no"],
        sourceRefs: [ctx.sourceRef(ASK_PATH)],
        idempotencyKey: "test.compose-question:ask",
      }),
    ];
  },
});
