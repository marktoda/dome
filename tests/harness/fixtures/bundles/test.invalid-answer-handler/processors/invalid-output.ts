import {
  type Effect,
  type OutboxRecoveryEffect,
} from "../../../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
} from "../../../../../../src/core/processor";

const invalidOutput: Processor = defineProcessor({
  id: "test.invalid-answer-handler.invalid-output",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    {
      kind: "answer",
      idempotencyKeyPrefix: "test.invalid-answer-handler:",
    },
  ],
  capabilities: [{ kind: "outbox.recover", actions: ["retry"] }],
  run: async (): Promise<ReadonlyArray<Effect>> => {
    const malformed = {
      kind: "outbox-recovery",
      action: "retry",
      idempotencyKey: "missing-reason",
      sourceRefs: [],
    } as unknown as OutboxRecoveryEffect;
    return [malformed];
  },
});

export default invalidOutput;
