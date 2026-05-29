import { viewEffect } from "../../../../../../src/core/effect";
import { defineProcessor } from "../../../../../../src/core/processor";

export default defineProcessor({
  id: "test.bad-query-view.query",
  version: "0.1.0",
  phase: "view",
  triggers: [{ kind: "command", name: "query" }],
  capabilities: [{ kind: "read", paths: ["**/*.md"] }],
  run: async () => [
    viewEffect({
      name: "test.bad-query-view.query",
      content: {
        kind: "structured",
        schema: "test.bad-query-view/v1",
        data: Object.freeze({
          schema: "test.bad-query-view/v1",
          ok: true,
        }),
      },
      scope: Object.freeze([]),
    }),
  ],
});
