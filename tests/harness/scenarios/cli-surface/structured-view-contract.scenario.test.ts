import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const BAD_QUERY_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.bad-query-view",
);

scenario(
  {
    name: "cli-surface: dedicated view wrappers reject wrong structured view",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "phase", phase: "view" },
      { kind: "trigger", trigger: "command" },
      { kind: "capability", capability: "read" },
      { kind: "effect", effect: "view" },
    ],
    harness: {
      bundles: [{ id: "test.bad-query-view", root: BAD_QUERY_BUNDLE }],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  test.bad-query-view:
    enabled: true
    grant:
      read:
        - "**/*.md"
`,
        "wiki/example.md": "# Example\n\nAlpha launch notes.\n",
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const cli = await h.runCli(["query", "alpha", "--json"]);
    expect(cli.exitCode).toBe(1);
    expect(cli.stdout).toBe("");
    expect(cli.stderr).toContain(
      "dome query: expected view 'dome.search.query', got 'test.bad-query-view.query'.",
    );
  },
);
