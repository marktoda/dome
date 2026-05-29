import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const FIXTURE_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.scheduled-slow",
);

const PROCESSOR_ID = "test.scheduled-slow.wait-for-abort";

scenario(
  {
    name: "capabilities: vault processor timeout cap bounds scheduled operational dispatch",
    tags: [
      { kind: "group", group: "capabilities" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "garden" },
      { kind: "trigger", trigger: "schedule" },
    ],
    harness: {
      bundles: [{ id: "test.scheduled-slow", root: FIXTURE_BUNDLE }],
      initialFiles: {
        ".dome/config.yaml": `
engine:
  processor_timeout_ms: 5
extensions:
  test.scheduled-slow:
    enabled: true
`,
      },
    },
  },
  async (h) => {
    const result = await h.tick();
    expect(result.adopted).toBe(true);

    const row = await h
      .expectLedger({ processorId: PROCESSOR_ID, status: "timed_out" })
      .toHaveExactlyOne();
    const error = JSON.parse(row.error ?? "{}");
    expect(error.code).toBe("processor.timeout");
    expect(error.message).toContain("5ms");

    await h
      .expectProjection()
      .diagnostics({ code: "processor.timeout", severity: "error" })
      .toHaveCount(1);

    const immediateRetry = await h.tick();
    expect(immediateRetry.hadDrift).toBe(false);
    await h
      .expectLedger({ processorId: PROCESSOR_ID, status: "timed_out" })
      .toHaveCount(1);

    await h.advance(60_000);
    const nextInterval = await h.tick();
    expect(nextInterval.hadDrift).toBe(false);
    await h
      .expectLedger({ processorId: PROCESSOR_ID, status: "timed_out" })
      .toHaveCount(2);
  },
);
