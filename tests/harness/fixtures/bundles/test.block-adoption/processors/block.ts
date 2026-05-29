import type { ProcessorContext } from "../../../../../../src/core/processor";

const processor = {
  id: "test.block-adoption.always",
  version: "0.1.0",
  phase: "adoption",
  triggers: [{ kind: "signal", name: "document.changed" }],
  capabilities: [{ kind: "read", paths: ["wiki/**"] }],
  run: async (ctx: ProcessorContext<unknown>) => {
    const refPath = ctx.changedPaths.find((path: string) => path.endsWith(".md"));
    return [
      {
        kind: "diagnostic",
        severity: "block",
        code: "test.block-adoption.blocked",
        message: "intentional adoption block",
        sourceRefs: refPath === undefined ? [] : [ctx.sourceRef(refPath)],
      },
    ];
  },
};

export default processor;
