// Test fixture: answer handler that relaxes a vault-local page type.

import {
  patchEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../../../src/core/processor";

const PAGE_TYPES_PATH = ".dome/page-types.yaml";

const RELAX_PAGE_TYPES: FileChangeInput = {
  kind: "write",
  path: PAGE_TYPES_PATH,
  content:
    "extensions:\n" +
    "  - name: recipe\n" +
    "    frontmatter_extras:\n" +
    "      cuisine: optional\n" +
    "      unexpected: optional\n",
};

const processor: Processor = defineProcessor({
  id: "test.page-type-job-flow.answer-worker",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    {
      kind: "answer",
      idempotencyKeyPrefix: "dome.markdown.ambiguous-wikilink:",
    },
  ],
  capabilities: [{ kind: "patch.auto", paths: [PAGE_TYPES_PATH] }],
  run: async (
    ctx: ProcessorContext<unknown>,
  ): Promise<ReadonlyArray<Effect>> => {
    const input = ctx.input as { readonly kind?: unknown };
    if (input.kind !== "answer") return [];
    return [
      patchEffect({
        mode: "auto",
        changes: [RELAX_PAGE_TYPES],
        reason: "test fixture: answer handler relaxes recipe page type",
        sourceRefs: [],
      }),
    ];
  },
});

export default processor;
