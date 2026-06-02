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
    timeoutMs: 30_000,
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

    // Step 4: editing the page to remove links clears the old extracted facts.
    await h.userCommit({
      files: {
        "wiki/source.md": "# source\n\nThe source no longer links anywhere.\n",
      },
      message: "remove source wikilinks",
    });
    const removeResult = await h.tick();
    expect(removeResult.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.graph.links_to",
        subjectId: "wiki/source.md",
      })
      .toHaveCount(0);

    // Step 5: a later replacement run inserts only the current links.
    await h.userCommit({
      files: {
        "wiki/source.md": "# source\n\nNow it only mentions [[entity-c]].\n",
      },
      message: "replace source wikilinks",
    });
    const replaceResult = await h.tick();
    expect(replaceResult.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.graph.links_to",
        subjectId: "wiki/source.md",
      })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.graph.links_to",
        subjectId: "wiki/source.md",
        objectString: "entity-c",
      })
      .toHaveCount(1);

    // Step 6: ledger records succeeded runs for dome.graph.links.
    await h
      .expectLedger({ processorId: "dome.graph.links" })
      .toAllHaveStatus("succeeded");
  },
);

scenario(
  {
    name: "effect-kinds: dome.graph.links handles real-vault link volume",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "fact" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "graph.write" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: { bundles: ["dome.markdown", "dome.graph"] },
    timeoutMs: 60_000,
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const linkCount = 10_025;
    const body = Array.from(
      { length: linkCount },
      (_, i) => `- [[target-${i}]]`,
    ).join("\n");

    await h.userCommit({
      files: {
        "wiki/dense-links.md": `# dense links\n\n${body}\n`,
      },
      message: "add dense wikilink page",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.graph.links_to",
        subjectId: "wiki/dense-links.md",
      })
      .toHaveCount(linkCount);

    await h
      .expectLedger({ processorId: "dome.graph.links" })
      .toAllHaveStatus("succeeded");
  },
);
