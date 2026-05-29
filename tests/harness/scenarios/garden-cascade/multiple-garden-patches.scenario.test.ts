import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const FIXTURE_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.multi-garden-patch",
);

scenario(
  {
    name: "garden-cascade: multiple garden patches chain on latest adopted ref",
    tags: [
      { kind: "group", group: "garden-cascade" },
      { kind: "effect", effect: "patch" },
      { kind: "phase", phase: "garden" },
    ],
    harness: {
      bundles: [{ id: "test.multi-garden-patch", root: FIXTURE_BUNDLE }],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  test.multi-garden-patch:
    enabled: true
    grant:
      patch.auto: ["wiki/**"]
`,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: { "wiki/seed.md": "# Seed\n" },
      message: "trigger multiple garden patches",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);
    expect(result.hadDrift).toBe(true);

    await h.expectFile("wiki/first.md").toContain("first garden patch");
    await h.expectFile("wiki/second.md").toContain("second garden patch");

    const refs = await h.refs.current();
    expect(refs.adopted).toBe(refs.head);
    if (refs.adopted === null) throw new Error("expected adopted ref");
    expect(result.adoptedAfter).toBe(refs.adopted);
  },
);
