// scenarios/effect-kinds/bundle-page-type-schema.scenario.test.ts
//
// Bundle-contributed page types flow through the loader into ProcessorContext;
// lint-frontmatter consumes them without reading bundle directories itself.

import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const FIXTURE_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.page-types",
);

scenario(
  {
    name: "effect-kinds: bundle-contributed page types validate in lint-frontmatter",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: [
        "dome.markdown",
        { id: "test.page-types", root: FIXTURE_BUNDLE },
      ],
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/decisions/reorg.md":
          "---\n" +
          "type: decision\n" +
          "created: 2026-05-28\n" +
          "updated: 2026-05-28\n" +
          "---\n" +
          "# Reorg\n",
      },
      message: "add decision without owner",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.missing-required-field" })
      .toHaveCount(1);
    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.type-unknown" })
      .toHaveCount(0);
  },
);
