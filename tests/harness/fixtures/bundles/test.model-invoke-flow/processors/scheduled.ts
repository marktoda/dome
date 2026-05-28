// Test fixture: scheduled garden processor that requires ctx.modelInvoke.

import {
  diagnosticEffect,
  type Effect,
} from "../../../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../../../src/core/processor";

const processor: Processor = defineProcessor({
  id: "test.model-invoke-flow.scheduled",
  version: "0.1.0",
  phase: "garden",
  triggers: [{ kind: "schedule", cron: "* * * * *" }],
  capabilities: [
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
    const parsed = await ctx.modelInvoke.structured({
      prompt: "Return JSON: {\"ok\": true}",
      model: "test-model",
      schemaName: "test.model-invoke-flow/v1",
      parse: (value) => {
        if (
          typeof value === "object" &&
          value !== null &&
          (value as { readonly ok?: unknown }).ok === true
        ) {
          return value as { readonly ok: true };
        }
        throw new Error("expected ok=true");
      },
    });

    return [
      diagnosticEffect({
        severity: "info",
        code: "test.model.invoke.ok",
        message: `scheduled model returned ok=${parsed.ok}`,
        sourceRefs: [],
      }),
    ];
  },
});

export default processor;
