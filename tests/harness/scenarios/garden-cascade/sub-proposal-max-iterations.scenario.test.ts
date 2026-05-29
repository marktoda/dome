import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const FIXTURE_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.subproposal-max-iterations",
);

scenario(
  {
    name: "garden-cascade: sub-Proposal adoption inherits max_iterations",
    tags: [
      { kind: "group", group: "garden-cascade" },
      { kind: "phase", phase: "garden" },
      { kind: "phase", phase: "adoption" },
      { kind: "effect", effect: "patch" },
    ],
    harness: {
      bundles: [
        { id: "test.subproposal-max-iterations", root: FIXTURE_BUNDLE },
      ],
      initialFiles: {
        ".dome/config.yaml": `
engine:
  max_iterations: 2
extensions:
  test.subproposal-max-iterations:
    enabled: true
    grant:
      read: ["wiki/**"]
      patch.auto: ["wiki/**"]
`,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: { "wiki/trigger.md": "# Trigger\n" },
      message: "trigger garden sub-proposal divergence",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    const inspect = await h.runCli(["inspect", "diagnostics", "--json"]);
    expect(inspect.exitCode).toBe(0);
    const diagnostics = JSON.parse(inspect.stdout) as ReadonlyArray<{
      readonly code: string;
      readonly message: string;
    }>;
    const divergence = diagnostics.find(
      (diagnostic) => diagnostic.code === "fixed-point.divergence",
    );
    expect(divergence?.message).toContain("MAX_ITER=2");
  },
);
