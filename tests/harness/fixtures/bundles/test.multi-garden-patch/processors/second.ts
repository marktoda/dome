import {
  patchEffect,
  type Effect,
} from "../../../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
} from "../../../../../../src/core/processor";

const processor: Processor = defineProcessor({
  id: "test.multi-garden-patch.second",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    { kind: "signal", name: "file.created", pathPattern: "wiki/seed.md" },
  ],
  capabilities: [
    { kind: "read", paths: ["wiki/**"] },
    { kind: "patch.auto", paths: ["wiki/**"] },
  ],
  run: async (): Promise<ReadonlyArray<Effect>> => [
    patchEffect({
      mode: "auto",
      changes: [
        {
          kind: "write",
          path: "wiki/second.md",
          content: "# Second\n\nCreated by second garden patch.\n",
        },
      ],
      reason: "test fixture: second garden patch",
      sourceRefs: [],
    }),
  ],
});

export default processor;
