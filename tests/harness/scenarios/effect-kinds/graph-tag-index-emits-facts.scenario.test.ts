// scenarios/effect-kinds/graph-tag-index-emits-facts.scenario.test.ts
//
// dome.graph.tag-index emits one `dome.graph.tagged` FactEffect per unique tag
// on a changed page. This is intentionally an engine harness scenario rather
// than a parser unit test: it exercises bundle loading, adoption dispatch,
// capability enforcement, projection writes, and ledger recording together.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "effect-kinds: dome.graph.tag-index emits tagged facts per page",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "fact" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "graph.write" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: { bundles: ["dome.markdown", "dome.graph"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/tagged.md":
          "---\n" +
          "type: note\n" +
          "tags:\n" +
          "  - leadership\n" +
          "  - project/platform\n" +
          "---\n" +
          "# HeadingTag\n\n" +
          "Body mentions #operations and repeats #leadership.\n",
      },
      message: "add tagged page",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.graph.tagged",
        subjectId: "wiki/tagged.md",
      })
      .toHaveCount(3);

    for (const tag of ["leadership", "project/platform", "operations"]) {
      await h
        .expectProjection()
        .facts({
          predicate: "dome.graph.tagged",
          subjectId: "wiki/tagged.md",
          objectString: tag,
        })
        .toHaveCount(1);
    }

    await h
      .expectProjection()
      .facts({
        predicate: "dome.graph.tagged",
        subjectId: "wiki/tagged.md",
        objectString: "headingtag",
      })
      .toHaveCount(0);

    await h
      .expectLedger({ processorId: "dome.graph.tag-index" })
      .toAllHaveStatus("succeeded");
  },
);
