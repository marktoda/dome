import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const FIXTURE_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.model-write-provenance",
);

const PROCESSOR_ID = "test.model-write-provenance.emit";
const OUTPUT_PATH = "wiki/generated/model-write.md";

scenario(
  {
    name: "capabilities: model PatchEffect without SourceRefs is rejected before routing",
    tags: [
      { kind: "group", group: "capabilities" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "capability", capability: "model.invoke" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: [{ id: "test.model-write-provenance", root: FIXTURE_BUNDLE }],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  test.model-write-provenance:
    enabled: true
    grant:
      read: ["inbox/raw/**"]
      patch.auto: ["wiki/generated/**"]
      model.invoke:
        modelAllowlist: ["test-model"]
`,
      },
      modelProvider: async () => {
        return { text: "{\"sourceBacked\":false}", costUsd: 0.01 };
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "inbox/raw/capture.md": "# Capture\n\nTurn this into a note.\n",
      },
      message: "capture",
    });
    const result = await h.tick();
    expect(result.adopted).toBe(true);

    const failed = await h
      .expectLedger({ processorId: PROCESSOR_ID, status: "failed" })
      .toHaveExactlyOne();
    expect(JSON.parse(failed.error ?? "{}")).toMatchObject({
      code: "processor.invalid-output",
      retryable: false,
    });
    await h
      .expectProjection()
      .diagnostics({ code: "processor.invalid-output", severity: "error" })
      .toContainMessage("SourceRef");
    await h.expectFile(OUTPUT_PATH).toBeAbsent();
  },
);

scenario(
  {
    name: "capabilities: model PatchEffect with SourceRefs routes through garden sub-proposal",
    tags: [
      { kind: "group", group: "capabilities" },
      { kind: "effect", effect: "patch" },
      { kind: "capability", capability: "model.invoke" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: [{ id: "test.model-write-provenance", root: FIXTURE_BUNDLE }],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  test.model-write-provenance:
    enabled: true
    grant:
      read: ["inbox/raw/**"]
      patch.auto: ["wiki/generated/**"]
      model.invoke:
        modelAllowlist: ["test-model"]
`,
      },
      modelProvider: async () => {
        return { text: "{\"sourceBacked\":true}", costUsd: 0.01 };
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "inbox/raw/capture.md": "# Capture\n\nTurn this into a note.\n",
      },
      message: "capture",
    });
    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h
      .expectLedger({ processorId: PROCESSOR_ID, status: "succeeded" })
      .toHaveExactlyOne();
    await h.expectFile(OUTPUT_PATH).toContain("Source: inbox/raw/capture.md");
    await h.expectFile(OUTPUT_PATH).toContain("Turn this into a note.");
  },
);
