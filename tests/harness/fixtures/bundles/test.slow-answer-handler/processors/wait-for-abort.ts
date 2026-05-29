import { defineProcessor } from "../../../../../../src/core/processor";

export default defineProcessor({
  id: "test.slow-answer-handler.wait-for-abort",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    {
      kind: "answer",
      idempotencyKeyPrefix: "test.slow-answer-handler:",
    },
  ],
  capabilities: [],
  execution: {
    class: "background",
    timeoutMs: 600_000,
  },
  run: async (ctx) => {
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) {
        resolve();
        return;
      }
      ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return [];
  },
});
