import { defineProcessor } from "../../../../../../src/core/processor";

export default defineProcessor({
  id: "test.throwing-view.throw",
  version: "0.1.0",
  phase: "view",
  triggers: [{ kind: "command", name: "throw-view" }],
  capabilities: [],
  run: async () => {
    throw new Error("intentional view failure");
  },
});
