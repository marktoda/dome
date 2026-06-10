// scenarios/effect-kinds/claims-index-facts.scenario.test.ts
//
// dome.claims.index projects bold-key claim lines into page-scoped facts with
// stable source-ref identities. Re-inspecting a changed/deleted page replaces
// stale facts for that page, exercising the file.deleted trigger path. Removing
// that trigger from the manifest must break the delete-clears-facts assertion.

import { expect } from "bun:test";

import { scenario } from "../../index";
import type { Harness } from "../../types";

// ----- sourceRef helpers (local — not imported across test files) ----------

type SourceRefRow = {
  readonly source_refs: string;
  readonly object_json?: string;
};

type SourceRefProjection = {
  readonly path?: unknown;
  readonly stableId?: unknown;
  readonly range?: {
    readonly startLine?: unknown;
    readonly endLine?: unknown;
  };
};

function sourceRefRowsForFacts(
  h: Harness,
  filter: {
    readonly predicate: string;
    readonly subjectId: string;
    readonly objectString?: string;
  },
): ReadonlyArray<ReadonlyArray<SourceRefProjection>> {
  const rows = h.projection.raw
    .query<SourceRefRow, [string, string]>(
      "SELECT source_refs, object_json FROM facts WHERE predicate = ? AND subject_id = ?",
    )
    .all(filter.predicate, filter.subjectId);
  return rows
    .filter((row) =>
      filter.objectString === undefined ||
      rowObjectString(row.object_json) === filter.objectString
    )
    .map((row) => JSON.parse(row.source_refs) as SourceRefProjection[]);
}

function rowObjectString(objectJson: string | undefined): string | null {
  if (objectJson === undefined) return null;
  const parsed = JSON.parse(objectJson) as {
    readonly kind?: unknown;
    readonly value?: unknown;
  };
  return parsed.kind === "string" && typeof parsed.value === "string"
    ? parsed.value
    : null;
}

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

    // Beat 1: commit a page with a pre-anchored claim line. Hand anchors are
    // preserved by the stamper; the anchor becomes the stableId on the
    // sourceRef. The fact value must NOT include the anchor text.
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
          "- **Status:** alpha ^c12345678",
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

    // The fact's object encodes the key/value pair — anchor is stripped from
    // claim.value so the objectString is unchanged vs. an un-anchored line.
    await h
      .expectProjection()
      .facts({
        predicate: "dome.claims.claim",
        subjectId: path,
        objectString: claimJson("Status", "alpha"),
      })
      .toHaveCount(1);

    // The sourceRef carries the anchor as stableId.
    const createdRefs = sourceRefRowsForFacts(h, {
      predicate: "dome.claims.claim",
      subjectId: path,
      objectString: claimJson("Status", "alpha"),
    });
    expect(createdRefs).toHaveLength(1);
    const createdRef = createdRefs[0]?.[0];
    expect(createdRef?.stableId).toBe("c12345678");

    // Beat 2: edit the claim value in place, keeping the anchor. The replaced
    // fact should carry the same stableId — supersession-identity property.
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
          "- **Status:** beta ^c12345678",
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

    // Replaced fact still carries the same stableId — anchor is the identity
    // across value supersessions.
    const editedRefs = sourceRefRowsForFacts(h, {
      predicate: "dome.claims.claim",
      subjectId: path,
      objectString: claimJson("Status", "beta"),
    });
    expect(editedRefs).toHaveLength(1);
    const editedRef = editedRefs[0]?.[0];
    expect(editedRef?.stableId).toBe("c12345678");

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

