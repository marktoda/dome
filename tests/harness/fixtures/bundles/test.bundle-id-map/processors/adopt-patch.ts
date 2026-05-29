import { patchEffect } from "../../../../../../src/core/effect";
import { defineProcessor } from "../../../../../../src/core/processor";

export default defineProcessor({
  id: "acme.notbundle.adopt-patch",
  version: "0.1.0",
  phase: "adoption",
  triggers: [
    { kind: "signal", name: "file.created", pathPattern: "wiki/adopt.md" },
  ],
  capabilities: [
    { kind: "read", paths: ["wiki/**"] },
    { kind: "patch.auto", paths: ["wiki/**"] },
  ],
  run: async (ctx) => {
    const content = await ctx.snapshot.readFile("wiki/adopt.md");
    const normalized = "# Adopt\n\nNormalized by adoption.\n";
    if (content === normalized) return [];
    return [
      patchEffect({
        mode: "auto",
        changes: [
          {
            kind: "write",
            path: "wiki/adopt.md",
            content: normalized,
          },
        ],
        reason: "test fixture: adoption patch with non-prefix bundle id",
        sourceRefs: [],
      }),
    ];
  },
});
