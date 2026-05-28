// Test fixture: queued garden worker that emits an auto patch.

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

const OUTPUT_PATH = "wiki/job-output.md";

const WRITE_OUTPUT: FileChangeInput = {
  kind: "write",
  path: OUTPUT_PATH,
  content: "# Job Output\n\nCreated by a queued garden worker.\n",
};

const processor: Processor = defineProcessor({
  id: "test.job-patch-flow.worker",
  version: "0.1.0",
  phase: "garden",
  triggers: [{ kind: "signal", name: "document.changed" }],
  capabilities: [{ kind: "patch.auto", paths: ["wiki/**"] }],
  run: async (
    ctx: ProcessorContext<unknown>,
  ): Promise<ReadonlyArray<Effect>> => {
    const input = ctx.input as { readonly seedPath?: unknown };
    if (input.seedPath !== "wiki/seed.md") return [];
    return [
      patchEffect({
        mode: "auto",
        changes: [WRITE_OUTPUT],
        reason: "test fixture: queued job creates wiki/job-output.md",
        sourceRefs: [],
      }),
    ];
  },
});

export default processor;
