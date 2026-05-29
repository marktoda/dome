import { defineProcessor } from "../../../../../../src/core/processor";

export default defineProcessor({
  id: "test.slow-adoption.sleep",
  version: "0.1.0",
  phase: "adoption",
  triggers: [{ kind: "path", pattern: "wiki/slow.md" }],
  capabilities: [{ kind: "read", paths: ["wiki/**"] }],
  run: async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    return [];
  },
});
