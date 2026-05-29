import { patchEffect } from "../../../../../../src/core/effect";
import { defineProcessor } from "../../../../../../src/core/processor";

export default defineProcessor({
  id: "test.subproposal-max-iterations.emit-garden-patch",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    { kind: "signal", name: "file.created", pathPattern: "wiki/trigger.md" },
  ],
  capabilities: [
    { kind: "read", paths: ["wiki/**"] },
    { kind: "patch.auto", paths: ["wiki/**"] },
  ],
  run: async () => [
    patchEffect({
      mode: "auto",
      changes: [
        {
          kind: "write",
          path: "wiki/from-garden.md",
          content: "# From garden\n",
        },
      ],
      reason: "create sub-proposal divergence target",
      sourceRefs: [],
    }),
  ],
});
