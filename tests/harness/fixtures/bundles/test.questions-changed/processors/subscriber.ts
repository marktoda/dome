// test.questions-changed.subscriber — harness fixture-bundle processor.
//
// Garden-phase subscriber to the `questions.changed` operational signal. It
// deliberately asks a question of its own on every dispatch: that re-sets the
// host tick's questions-changed flag DURING the epilogue dispatch, which is
// exactly the recursion the flag contract must absorb — the scenario asserts
// this processor still runs at most once per tick (the re-set flag waits for
// a future tick; it never loops the same one).

import {
  questionEffect,
  type Effect,
} from "../../../../../../src/core/effect";
import { defineProcessor } from "../../../../../../src/core/processor";

export default defineProcessor({
  id: "test.questions-changed.subscriber",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    {
      kind: "signal",
      name: "questions.changed",
    },
  ],
  capabilities: [{ kind: "question.ask" }],
  async run(): Promise<Effect[]> {
    return [
      questionEffect({
        question: "test.questions-changed: follow-up from the subscriber?",
        sourceRefs: [],
        idempotencyKey: "test.questions-changed:subscriber-follow-up",
      }),
    ];
  },
});
