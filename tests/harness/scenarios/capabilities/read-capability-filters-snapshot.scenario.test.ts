import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const FIXTURE_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.read-capability-gate",
);

scenario(
  {
    name: "capabilities: read grants filter ctx.snapshot reads and listings",
    tags: [
      { kind: "group", group: "capabilities" },
      { kind: "capability", capability: "read" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "adoption" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: [{ id: "test.read-capability-gate", root: FIXTURE_BUNDLE }],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  test.read-capability-gate:
    enabled: true
    grant:
      read: ["wiki/**"]
`,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      message: "add readable and denied markdown",
      files: {
        "wiki/allowed.md": "# Allowed\n\nvisible\n",
        "secret/denied.md": "# Denied\n\nhidden\n",
      },
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h
      .expectProjection()
      .diagnostics({ code: "test.read-capability.ok" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .diagnostics({ code: "test.read-capability.leak" })
      .toHaveCount(0);
    await h
      .expectLedger({ processorId: "test.read-capability-gate.probe" })
      .toHaveAtLeastOne();
  },
);
