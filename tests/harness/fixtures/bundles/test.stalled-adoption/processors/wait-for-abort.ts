import { defineProcessor } from "../../../../../../src/core/processor";

export default defineProcessor({
  id: "test.stalled-adoption.wait-for-abort",
  version: "0.1.0",
  phase: "adoption",
  triggers: [{ kind: "path", pattern: "wiki/stalled.md" }],
  capabilities: [{ kind: "read", paths: ["wiki/**"] }],
  execution: { class: "deterministic", timeoutMs: 60_000 },
  run: async (ctx) => {
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) return resolve();
      ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return [];
  },
});
