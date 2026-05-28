// scenarios/effect-kinds/page-type-schema-diagnostics.scenario.test.ts
//
// Page-type schemas are vault substrate: the markdown linter reads
// `.dome/page-types.yaml` through ctx.snapshot and validates changed pages
// against the declared type extras without leaving processor purity.

import { expect } from "bun:test";

import { scenario } from "../../index";

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
  },
);
