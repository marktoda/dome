// test.questions-changed.ask — harness fixture-bundle processor.
//
// Garden-phase processor that asks one durable question when wiki/ask.md is
// created. Its `recordQuestion` sink write is the emit point that must set
// the host tick's questions-changed flag, driving the epilogue dispatch of
// `questions.changed` subscribers.

import {
  questionEffect,
  type Effect,
} from "../../../../../../src/core/effect";
import { defineProcessor } from "../../../../../../src/core/processor";

const ASK_PATH = "wiki/ask.md";

export default defineProcessor({
  id: "test.questions-changed.ask",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    {
      kind: "signal",
      name: "file.created",
      pathPattern: ASK_PATH,
    },
  ],
  capabilities: [
    { kind: "read", paths: [ASK_PATH] },
    { kind: "question.ask" },
  ],
  async run(ctx): Promise<Effect[]> {
    return [
      questionEffect({
        question: "test.questions-changed: is this the right owner?",
        sourceRefs: [ctx.sourceRef(ASK_PATH)],
        idempotencyKey: "test.questions-changed:ask",
      }),
    ];
  },
});
