// test.outbox-recovery.answer — harness fixture-bundle processor.
//
// It proves outbox recovery is not a CLI/database backdoor: a durable
// question answer dispatches a normal garden processor, that processor emits
// an OutboxRecoveryEffect, and the engine applies it through the usual
// capability broker and effect sinks.

import {
  diagnosticEffect,
  outboxRecoveryEffect,
  type Effect,
  type QuestionEffect,
} from "../../../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../../../src/core/processor";

type AnswerInput = {
  readonly kind: "answer";
  readonly questionId: number;
  readonly answer: string;
  readonly question: QuestionEffect;
};

const PREFIX = "test.outbox-recovery:";

const processor: Processor<AnswerInput> = defineProcessor({
  id: "test.outbox-recovery.answer",
  version: "0.1.0",
  phase: "garden",
  triggers: [{ kind: "answer", idempotencyKeyPrefix: PREFIX }],
  capabilities: [{ kind: "outbox.recover", actions: ["retry", "abandon"] }],
  run: async (
    ctx: ProcessorContext<AnswerInput>,
  ): Promise<ReadonlyArray<Effect>> => {
    const action = parseAction(ctx.input.answer);
    if (action === null) {
      return [
        diagnosticEffect({
          severity: "error",
          code: "test.outbox-recovery.invalid-answer",
          message: `Unsupported outbox recovery answer '${ctx.input.answer}'.`,
          sourceRefs: ctx.input.question.sourceRefs,
        }),
      ];
    }

    const idempotencyKey = ctx.input.question.idempotencyKey.slice(PREFIX.length);
    return [
      outboxRecoveryEffect({
        action,
        idempotencyKey,
        reason: `test fixture: ${action} failed outbox row`,
        sourceRefs: ctx.input.question.sourceRefs,
      }),
    ];
  },
});

function parseAction(value: string): "retry" | "abandon" | null {
  return value === "retry" || value === "abandon" ? value : null;
}

export default processor;
