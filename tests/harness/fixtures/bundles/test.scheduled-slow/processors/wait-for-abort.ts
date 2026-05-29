import { defineProcessor } from "../../../../../../src/core/processor";

export default defineProcessor({
  id: "test.scheduled-slow.wait-for-abort",
  version: "0.1.0",
  phase: "garden",
  triggers: [{ kind: "schedule", cron: "* * * * *" }],
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
