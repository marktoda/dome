import {
  diagnosticEffect,
  type Effect,
} from "../../../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
} from "../../../../../../src/core/processor";

const processor: Processor = defineProcessor({
  id: "test.inbox-signal.observe",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    { kind: "signal", name: "file.created", pathPattern: "inbox/raw/*.md" },
    { kind: "signal", name: "document.changed", pathPattern: "inbox/raw/*.md" },
  ],
  capabilities: [{ kind: "read", paths: ["inbox/**"] }],
  run: async (ctx): Promise<ReadonlyArray<Effect>> => [
    diagnosticEffect({
      severity: "info",
      code: "test.inbox-signal.observed",
      message: `observed: ${ctx.changedPaths.join(",")}`,
      sourceRefs: [],
    }),
  ],
});

export default processor;
