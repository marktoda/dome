import { patchEffect } from "../../../../../../src/core/effect";
import { defineProcessor } from "../../../../../../src/core/processor";

export default defineProcessor({
  id: "acme.notbundle.garden-patch",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    { kind: "signal", name: "file.created", pathPattern: "wiki/seed.md" },
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
          content: "# From Garden\n\nCreated by garden.\n",
        },
      ],
      reason: "test fixture: garden patch with non-prefix bundle id",
      sourceRefs: [],
    }),
  ],
});
