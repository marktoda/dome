// scenarios/effect-kinds/graph-links-emits-facts.scenario.test.ts
//
// dome.graph.links (Phase 13a) emits one FactEffect per wikilink in
// every changed markdown file. The capability broker enforces the
// `graph.write` declaration against the predicate's namespace — facts
// outside `dome.graph.*` would be denied. This scenario covers the
// first FactEffect-emitting processor + the first `graph.write`
// capability usage in the harness suite.

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "effect-kinds: dome.graph.links emits links_to facts per wikilink",
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
    // Step 0: init adopted ref.
    {
      const seed = await h.tick();
      expect(seed.adopted).toBe(true);
    }

    // Step 1: commit a file that wikilinks to two distinct targets.
    // Both link targets are unresolved in the vault — the dome.graph
    // processor records them as-written; resolution is a future
    // view-phase processor's concern.
    await h.userCommit({
      files: {
        "wiki/source.md":
          "# source\n\nThe source mentions [[entity-a]] and [[entity-b]].\n",
      },
      message: "add source page with two wikilinks",
    });

    // Step 2: adopt. dome.graph.links fires; broker writes two
    // FactEffect rows under the `dome.graph` namespace.
    const result = await h.tick();
    expect(result.adopted).toBe(true);

    // Step 3: exactly two `dome.graph.links_to` fact rows, both with
    // the changed page as subject.
    await h
      .expectProjection()
      .facts({ predicate: "dome.graph.links_to" })
      .toHaveCount(2);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.graph.links_to",
        subjectId: "wiki/source.md",
      })
      .toHaveCount(2);

    // Step 4: ledger records a succeeded run for dome.graph.links.
    await h
      .expectLedger({ processorId: "dome.graph.links" })
      .toAllHaveStatus("succeeded");
  },
);
