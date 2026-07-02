// test.questions-changed.subscriber — harness fixture-bundle processor.
//
// Garden-phase subscriber to the `questions.changed` operational signal. On
// its FIRST dispatch it asks a follow-up question of its own: that re-sets
// the host's questions-changed flag DURING the epilogue dispatch, which is
// exactly the recursion the flag contract must absorb — the scenario asserts
// this tick still dispatches at most once, the NEXT tick's epilogue carries
// the re-set flag and dispatches once more, and a further quiet tick stays
// silent. On later dispatches the subscriber sees its follow-up already open
// (via `ctx.operational.questions`, gated by `questions.read`) and emits
// nothing, so the carryover chain terminates.

import {
  questionEffect,
  type Effect,
} from "../../../../../../src/core/effect";
import { defineProcessor } from "../../../../../../src/core/processor";

const FOLLOW_UP_KEY = "test.questions-changed:subscriber-follow-up";

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
  capabilities: [{ kind: "question.ask" }, { kind: "questions.read" }],
  async run(ctx): Promise<Effect[]> {
    const open = ctx.operational?.questions({ resolved: false }) ?? [];
    if (open.some((q) => q.idempotencyKey === FOLLOW_UP_KEY)) return [];
    return [
      questionEffect({
        question: "test.questions-changed: follow-up from the subscriber?",
        sourceRefs: [],
        idempotencyKey: FOLLOW_UP_KEY,
      }),
    ];
  },
});
