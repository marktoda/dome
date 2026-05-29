import { patchEffect } from "../../../../../../src/core/effect";
import {
  defineProcessor,
  type ProcessorContext,
} from "../../../../../../src/core/processor";

const TARGET = "wiki/from-garden.md";

export default defineProcessor({
  id: "test.subproposal-max-iterations.diverge",
  version: "0.1.0",
  phase: "adoption",
  triggers: [{ kind: "path", pattern: TARGET }],
  capabilities: [
    { kind: "read", paths: ["wiki/**"] },
    { kind: "patch.auto", paths: ["wiki/**"] },
  ],
  run: async (ctx: ProcessorContext<unknown>) => {
    const current = await ctx.snapshot.readFile(TARGET);
    return [
      patchEffect({
        mode: "auto",
        changes: [
          {
            kind: "write",
            path: TARGET,
            content: `${current ?? ""}again\n`,
          },
        ],
        reason: "intentionally diverge until max_iterations",
        sourceRefs: [],
      }),
    ];
  },
});
