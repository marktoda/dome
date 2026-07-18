import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const FIXTURE_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.stalled-adoption",
);

const PROCESSOR_ID = "test.stalled-adoption.wait-for-abort";

scenario(
  {
    name: "capabilities: vault processor timeout cap returns before the adoption scenario watchdog",
    tags: [
      { kind: "group", group: "capabilities" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "trigger", trigger: "path" },
    ],
    harness: {
      bundles: [{ id: "test.stalled-adoption", root: FIXTURE_BUNDLE }],
      initialFiles: {
        ".dome/config.yaml": `
engine:
  processor_timeout_ms: 5
extensions:
  test.stalled-adoption:
    enabled: true
    grant:
      read:
        - "wiki/**"
`,
      },
    },
  },
  async (h) => {
    expect((await h.tick()).adopted).toBe(true);
    await h.userCommit({
      files: { "wiki/stalled.md": "# Stalled\n" },
      message: "trigger stalled adoption processor",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(false);

    const row = await h
      .expectLedger({ processorId: PROCESSOR_ID, status: "timed_out" })
      .toHaveExactlyOne();
    const error = JSON.parse(row.error ?? "{}");
    expect(error.code).toBe("processor.timeout");
    expect(error.message).toContain("5ms");
  },
);
