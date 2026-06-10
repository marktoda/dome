// scenarios/effect-kinds/claims-index-facts.scenario.test.ts
//
// dome.claims.index projects bold-key claim lines into page-scoped facts with
// stable source-ref identities. Re-inspecting a changed/deleted page replaces
// stale facts for that page, exercising the file.deleted trigger path. Removing
// that trigger from the manifest must break the delete-clears-facts assertion.

import { expect } from "bun:test";

import { scenario } from "../../index";

const CONFIG = `
extensions:
  dome.claims:
    enabled: true
    grant:
      read: ["wiki/**/*.md", "notes/*.md"]
      patch.auto: ["wiki/**/*.md", "notes/*.md"]
      graph.write: ["dome.claims.*"]
`;

// Encode a {key, value} pair the same way claimFactValue() does.
function claimJson(key: string, value: string): string {
  return JSON.stringify({ key, value });
}

scenario(
  {
    name: "effect-kinds: dome.claims.index replaces claim facts on edit and clears them on delete",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "fact" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "graph.write" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: ["dome.claims"],
      initialFiles: {
        ".dome/config.yaml": CONFIG,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const path = "wiki/projects/alpha.md";

    // Beat 1: commit a page with a single claim line.
    await h.userCommit({
      files: {
        [path]: [
          "---",
          "type: project",
          "title: Alpha",
          "---",
          "",
          "# Alpha",
          "",
          "- **Status:** alpha",
          "",
        ].join("\n"),
      },
      message: "add alpha claim",
    });
    const created = await h.tick();
    expect(created.adopted).toBe(true);

    // Exactly one dome.claims.claim fact for the page.
    await h
      .expectProjection()
      .facts({ predicate: "dome.claims.claim", subjectId: path })
      .toHaveCount(1);

    // The fact's object encodes the key/value pair.
    await h
      .expectProjection()
      .facts({
        predicate: "dome.claims.claim",
        subjectId: path,
        objectString: claimJson("Status", "alpha"),
      })
      .toHaveCount(1);

    // Beat 2: edit the claim value in place — old fact replaced, not accumulated.
    await h.userCommit({
      files: {
        [path]: [
          "---",
          "type: project",
          "title: Alpha",
          "---",
          "",
          "# Alpha",
          "",
          "- **Status:** beta",
          "",
        ].join("\n"),
      },
      message: "update alpha claim to beta",
    });
    const edited = await h.tick();
    expect(edited.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({ predicate: "dome.claims.claim", subjectId: path })
      .toHaveCount(1);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.claims.claim",
        subjectId: path,
        objectString: claimJson("Status", "beta"),
      })
      .toHaveCount(1);

    // Old value no longer present.
    await h
      .expectProjection()
      .facts({
        predicate: "dome.claims.claim",
        subjectId: path,
        objectString: claimJson("Status", "alpha"),
      })
      .toHaveCount(0);

    // Beat 3: delete the page — file.deleted trigger must fire and clear facts.
    await h.userCommit({
      files: { [path]: null },
      message: "delete alpha page",
    });
    const deleted = await h.tick();
    expect(deleted.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({ predicate: "dome.claims.claim", subjectId: path })
      .toHaveCount(0);

    await h
      .expectLedger({ processorId: "dome.claims.index" })
      .toAllHaveStatus("succeeded");
  },
);

scenario(
  {
    name: "effect-kinds: dome.claims.index handles multiple claim lines on one page",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "fact" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "graph.write" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: ["dome.claims"],
      initialFiles: {
        ".dome/config.yaml": CONFIG,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const path = "wiki/projects/beta.md";

    await h.userCommit({
      files: {
        [path]: [
          "# Beta",
          "",
          "**Owner:** Ada",
          "**Status:** active",
          "**Priority:** high",
          "",
        ].join("\n"),
      },
      message: "add multi-claim page",
    });
    const created = await h.tick();
    expect(created.adopted).toBe(true);

    // Three claim facts projected — one per line.
    await h
      .expectProjection()
      .facts({ predicate: "dome.claims.claim", subjectId: path })
      .toHaveCount(3);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.claims.claim",
        subjectId: path,
        objectString: claimJson("Owner", "Ada"),
      })
      .toHaveCount(1);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.claims.claim",
        subjectId: path,
        objectString: claimJson("Status", "active"),
      })
      .toHaveCount(1);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.claims.claim",
        subjectId: path,
        objectString: claimJson("Priority", "high"),
      })
      .toHaveCount(1);

    // Drop one claim — count goes to 2.
    await h.userCommit({
      files: {
        [path]: [
          "# Beta",
          "",
          "**Owner:** Ada",
          "**Status:** active",
          "",
        ].join("\n"),
      },
      message: "remove priority claim",
    });
    const edited = await h.tick();
    expect(edited.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({ predicate: "dome.claims.claim", subjectId: path })
      .toHaveCount(2);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.claims.claim",
        subjectId: path,
        objectString: claimJson("Priority", "high"),
      })
      .toHaveCount(0);
  },
);

