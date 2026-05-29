import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const FIXTURE_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.projection-read-scope",
);

scenario(
  {
    name: "capabilities: view projection reads are scoped by read grants",
    tags: [
      { kind: "group", group: "capabilities" },
      { kind: "capability", capability: "read" },
      { kind: "phase", phase: "view" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: {
      bundles: [
        "dome.markdown",
        "dome.graph",
        "dome.search",
        { id: "test.projection-read-scope", root: FIXTURE_BUNDLE },
      ],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  dome.markdown:
    enabled: true
    grant:
      read: ["**/*.md", "**/*.{png,jpg,jpeg,gif,webp,svg,avif}"]
      patch.auto: ["**/*.md"]
      question.ask: true
  dome.graph:
    enabled: true
    grant:
      read: ["**/*.md"]
      graph.write: ["dome.graph.*"]
  dome.search:
    enabled: true
    grant:
      read: ["**/*.md"]
      search.write: ["**/*.md"]
  test.projection-read-scope:
    enabled: true
    grant:
      read: ["wiki/public/**"]
`,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      message: "add public and secret docs",
      files: {
        "wiki/public/visible.md": "# Visible\n\nmarker [[missing-public]]\n",
        "wiki/secret/hidden.md": "# Hidden\n\nmarker [[missing-secret]]\n",
      },
    });

    const adopted = await h.tick();
    expect(adopted.adopted).toBe(true);
    await h
      .expectProjection()
      .facts({ predicate: "dome.graph.links_to" })
      .toHaveCount(2);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-wikilink" })
      .toHaveCount(2);

    const cli = await h.runCli(["run", "projection-read-scope", "--json"]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stderr).toBe("");

    const payload = JSON.parse(cli.stdout) as {
      readonly data: unknown;
    };
    const rendered = JSON.stringify(payload.data);
    expect(rendered).toContain("wiki/public/visible.md");
    expect(rendered).not.toContain("wiki/secret/hidden.md");
    expect(rendered).not.toContain("missing-secret");
    expect(rendered).not.toContain("Hidden");
  },
);
