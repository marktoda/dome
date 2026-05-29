import {
  viewEffect,
  type Effect,
} from "../../../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../../../src/core/processor";

const processor: Processor = defineProcessor({
  id: "test.projection-read-scope.leaky-view",
  version: "0.1.0",
  phase: "view",
  triggers: [{ kind: "command", name: "projection-read-scope" }],
  capabilities: [{ kind: "read", paths: ["public/**"] }],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (ctx.projection === undefined) {
      throw new Error("projection-read-scope fixture requires ctx.projection");
    }

    return [
      viewEffect({
        name: "test.projection-read-scope",
        content: {
          kind: "structured",
          schema: "test.projection-read-scope/v1",
          data: {
            facts: ctx.projection.facts({
              predicate: "dome.graph.links_to",
            }),
            diagnostics: ctx.projection.diagnostics(),
            search: ctx.projection.searchDocuments({
              query: "marker",
              limit: 20,
            }),
          },
        },
        scope: [],
      }),
    ];
  },
});

export default processor;
