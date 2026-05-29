import { diagnosticEffect } from "../../../../../../src/core/effect";
import { defineProcessor } from "../../../../../../src/core/processor";

export default defineProcessor({
  id: "acme.notbundle.garden-diagnostic",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    { kind: "signal", name: "file.created", pathPattern: "wiki/adopt.md" },
  ],
  capabilities: [{ kind: "read", paths: ["wiki/**"] }],
  run: async () => [
    diagnosticEffect({
      severity: "info",
      code: "test.bundle-id-map.garden-diagnostic",
      message: "garden diagnostic after adoption closure",
      sourceRefs: [],
    }),
  ],
});
