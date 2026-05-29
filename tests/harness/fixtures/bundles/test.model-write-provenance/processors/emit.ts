// Test fixture: model-capable garden processor that emits PatchEffects.

import { patchEffect, type Effect } from "../../../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../../../src/core/processor";

const OUTPUT_PATH = "wiki/generated/model-write.md";

const processor: Processor = defineProcessor({
  id: "test.model-write-provenance.emit",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    { kind: "signal", name: "file.created", pathPattern: "inbox/raw/*.md" },
  ],
  capabilities: [
    { kind: "read", paths: ["inbox/raw/**"] },
    { kind: "patch.auto", paths: ["wiki/generated/**"] },
    { kind: "model.invoke", modelAllowlist: ["test-model"] },
  ],
  execution: {
    class: "llm",
    timeoutMs: 1_000,
    modelCallTimeoutMs: 500,
  },
  run: async (
    ctx: ProcessorContext<unknown>,
  ): Promise<ReadonlyArray<Effect>> => {
    if (ctx.modelInvoke === undefined) {
      throw new Error("missing modelInvoke");
    }
    const sourcePath =
      ctx.changedPaths.find((path) => path.startsWith("inbox/raw/")) ??
      "inbox/raw/capture.md";
    const sourceBody = await ctx.snapshot.readFile(sourcePath);
    const result = await ctx.modelInvoke.structured({
      prompt: `Summarize ${sourcePath} as JSON: {"sourceBacked": true}.`,
      model: "test-model",
      schemaName: "test.model-write-provenance/v1",
      parse: (value) => {
        if (
          typeof value === "object" &&
          value !== null &&
          typeof (value as { readonly sourceBacked?: unknown })
            .sourceBacked === "boolean"
        ) {
          return value as { readonly sourceBacked: boolean };
        }
        throw new Error("expected sourceBacked boolean");
      },
    });

    return [
      patchEffect({
        mode: "auto",
        changes: [
          {
            kind: "write",
            path: OUTPUT_PATH,
            content:
              "# Model write\n\n" +
              `Source: ${sourcePath}\n\n` +
              `${sourceBody ?? ""}`,
          },
        ],
        reason: "test fixture: model-generated vault write",
        sourceRefs: result.sourceBacked ? [ctx.sourceRef(sourcePath)] : [],
      }),
    ];
  },
});

export default processor;
