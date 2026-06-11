import {
  diagnosticEffect,
  type Effect,
} from "../../../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
} from "../../../../../../src/core/processor";

// Mirrors dome.agent.ingest's shape: llm execution class, signal-triggered
// on inbox/raw — the processor class that went missing from the garden
// phase on 2026-06-10.
const processor: Processor = defineProcessor({
  id: "test.inbox-signal.llm-observe",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    { kind: "signal", name: "file.created", pathPattern: "inbox/raw/*.md" },
    { kind: "signal", name: "document.changed", pathPattern: "inbox/raw/*.md" },
  ],
  capabilities: [
    { kind: "read", paths: ["inbox/**"] },
    { kind: "model.invoke", maxDailyCostUsd: 5 },
  ],
  execution: { class: "llm", timeoutMs: 1000, modelCallTimeoutMs: 500 },
  run: async (ctx): Promise<ReadonlyArray<Effect>> => [
    diagnosticEffect({
      severity: "info",
      code: "test.inbox-signal.llm-observed",
      message: `llm-observed: ${ctx.changedPaths.join(",")}`,
      sourceRefs: [],
    }),
  ],
});

export default processor;
