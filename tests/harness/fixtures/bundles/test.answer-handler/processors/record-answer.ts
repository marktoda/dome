// test.answer-handler.record-duplicate-answer — harness fixture-bundle processor.
//
// Garden-phase answer handler used by the CLI-surface resolve/answer scenario.
// It proves that the durable question-resolution path does not stop at a
// projection-row mutation: the answered question dispatches a garden processor,
// and that processor's PatchEffect routes through the normal sub-Proposal
// adoption path.

import {
  patchEffect,
  type Effect,
  type FileChangeInput,
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
  readonly question: { readonly question: string };
};

const OUT_PATH = "wiki/answer-handled.md";

const processor: Processor<AnswerInput> = defineProcessor({
  id: "test.answer-handler.record-duplicate-answer",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    {
      kind: "answer",
      idempotencyKeyPrefix: "dome.markdown.duplicate-detection:",
    },
  ],
  capabilities: [
    { kind: "patch.auto", paths: ["wiki/**"] },
  ],
  run: async (
    ctx: ProcessorContext<AnswerInput>,
  ): Promise<ReadonlyArray<Effect>> => {
    const content =
      "---\n" +
      "type: note\n" +
      "---\n" +
      "# Answer handled\n\n" +
      `Question ${ctx.input.questionId}: ${ctx.input.answer}\n`;
    const change: FileChangeInput = {
      kind: "write",
      path: OUT_PATH,
      content,
    };
    return [
      patchEffect({
        mode: "auto",
        changes: [change],
        reason: "test fixture: materialize answer handler result",
        sourceRefs: [],
      }),
    ];
  },
});

export default processor;
