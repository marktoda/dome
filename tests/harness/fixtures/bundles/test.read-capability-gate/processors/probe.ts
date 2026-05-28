// Test fixture processor for ctx.snapshot read-capability enforcement.

import {
  diagnosticEffect,
  type Effect,
} from "../../../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../../../src/core/processor";

const ALLOWED = "wiki/allowed.md";
const DENIED = "secret/denied.md";

const processor: Processor = defineProcessor({
  id: "test.read-capability-gate.probe",
  version: "0.1.0",
  phase: "adoption",
  triggers: [{ kind: "signal", name: "file.created" }],
  capabilities: [{ kind: "read", paths: ["wiki/**"] }],
  run: async (
    ctx: ProcessorContext<unknown>,
  ): Promise<ReadonlyArray<Effect>> => {
    const allowed = await ctx.snapshot.readFile(ALLOWED);
    const denied = await ctx.snapshot.readFile(DENIED);
    const listed = await ctx.snapshot.listMarkdownFiles();

    // The harness first adopts .dome/config.yaml before committing the files
    // this probe is about. Stay silent until the readable fixture exists.
    if (allowed === null && denied === null && !listed.includes(ALLOWED)) {
      return [];
    }

    const leakedDeniedRead = denied !== null || listed.includes(DENIED);
    const missedAllowedRead = allowed === null || !listed.includes(ALLOWED);
    if (leakedDeniedRead || missedAllowedRead) {
      return [
        diagnosticEffect({
          severity: "error",
          code: "test.read-capability.leak",
          message:
            `read boundary failed: allowed=${allowed !== null}, ` +
            `denied=${denied !== null}, listed=${listed.join(",")}`,
          sourceRefs: allowed === null ? [] : [ctx.sourceRef(ALLOWED)],
        }),
      ];
    }

    return [
      diagnosticEffect({
        severity: "info",
        code: "test.read-capability.ok",
        message: "ctx.snapshot read capability filter held",
        sourceRefs: [ctx.sourceRef(ALLOWED)],
      }),
    ];
  },
});

export default processor;
