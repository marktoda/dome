// scenarios/effect-kinds/page-type-schema-diagnostics.scenario.test.ts
//
// Page-type schemas are vault substrate: the markdown linter reads
// `.dome/page-types.yaml` through ctx.snapshot and validates changed pages
// against the declared type extras without leaving processor purity.

import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const PAGE_TYPE_JOB_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.page-type-job-flow",
);

scenario(
  {
    name: "effect-kinds: dome.markdown.lint-frontmatter validates vault page-type schemas",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        ".dome/page-types.yaml":
          "extensions:\n" +
          "  - name: recipe\n" +
          "    frontmatter_extras:\n" +
          "      cuisine: required\n" +
          "      servings: optional\n",
        "wiki/recipes/soup.md":
          "---\n" +
          "type: recipe\n" +
          "created: 2026-05-28\n" +
          "updated: 2026-05-28\n" +
          "unexpected: yes\n" +
          "---\n" +
          "# Soup\n",
      },
      message: "add recipe page type",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.missing-required-field" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.unknown-frontmatter-field" })
      .toHaveCount(1);
    await h
      .expectLedger({ processorId: "dome.markdown.lint-frontmatter" })
      .toAllHaveStatus("succeeded");

    await h.userCommit({
      files: {
        ".dome/page-types.yaml":
          "extensions:\n" +
          "  - name: recipe\n" +
          "    frontmatter_extras:\n" +
          "      cuisine: optional\n" +
          "      servings: optional\n" +
          "      unexpected: optional\n",
      },
      message: "relax recipe page type",
    });

    const relaxed = await h.tick();
    expect(relaxed.adopted).toBe(true);

    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.missing-required-field" })
      .toHaveCount(0);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.unknown-frontmatter-field" })
      .toHaveCount(0);
  },
);

scenario(
  {
    name: "effect-kinds: operational page-type patches rebuild schema diagnostics",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "job" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "job.enqueue" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "route", route: "garden-job" },
    ],
    harness: {
      bundles: [
        "dome.markdown",
        { id: "test.page-type-job-flow", root: PAGE_TYPE_JOB_BUNDLE },
      ],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  dome.markdown:
    enabled: true
    grant:
      read: ["**/*.md", ".dome/page-types.yaml"]
      patch.auto: ["**/*.md"]
  test.page-type-job-flow:
    enabled: true
    grant:
      read: ["wiki/seed.md"]
      job.enqueue: ["test.page-type-job-flow.worker"]
      patch.auto: [".dome/page-types.yaml"]
`,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        ".dome/page-types.yaml":
          "extensions:\n" +
          "  - name: recipe\n" +
          "    frontmatter_extras:\n" +
          "      cuisine: required\n",
        "wiki/recipes/soup.md":
          "---\n" +
          "type: recipe\n" +
          "created: 2026-05-28\n" +
          "updated: 2026-05-28\n" +
          "unexpected: yes\n" +
          "---\n" +
          "# Soup\n",
      },
      message: "add recipe schema defect",
    });

    const defective = await h.tick();
    expect(defective.adopted).toBe(true);

    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.missing-required-field" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.unknown-frontmatter-field" })
      .toHaveCount(1);

    await h.userCommit({
      files: {
        "wiki/seed.md": "# Seed\n\nQueue the page-type cleanup job.\n",
      },
      message: "queue page-type cleanup",
    });

    const queued = await h.tick();
    expect(queued.adopted).toBe(true);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.missing-required-field" })
      .toHaveCount(1);

    await h.advance(60_000);
    const drained = await h.drainOperationalWork();
    expect(drained.jobs.drained).toEqual([
      expect.objectContaining({
        processorId: "test.page-type-job-flow.worker",
        status: "succeeded",
      }),
    ]);

    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.missing-required-field" })
      .toHaveCount(0);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.unknown-frontmatter-field" })
      .toHaveCount(0);
  },
);
