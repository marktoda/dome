// scenarios/effect-kinds/daily-task-index-facts.scenario.test.ts
//
// dome.daily.task-index projects explicit daily checkbox observations into
// page-scoped facts. The processor intentionally does not assign stable task
// identities yet; this scenario locks the current projection lifecycle:
// re-inspecting a changed/deleted daily replaces stale facts for that page.

import { expect } from "bun:test";

import { scenario } from "../../index";
import type { Harness } from "../../types";

const CONFIG = `
extensions:
  dome.daily:
    enabled: true
    grant:
      read: ["wiki/dailies/*.md"]
      patch.auto: ["wiki/dailies/*.md"]
      graph.write: ["dome.daily.*"]
      question.ask: true
`;

scenario(
  {
    name: "effect-kinds: dome.daily.task-index replaces task facts on edit and delete",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "fact" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "graph.write" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: ["dome.daily"],
      initialFiles: {
        ".dome/config.yaml": CONFIG,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/dailies/2026-01-03.md": [
          "---",
          "type: daily",
          "recurrence: 2026-01-03",
          "---",
          "",
          "# 2026-01-03",
          "",
          "- [ ] #followup Send Ada notes",
          "- [ ] Draft launch memo",
          "",
        ].join("\n"),
      },
      message: "add daily tasks",
    });
    const created = await h.tick();
    expect(created.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: "wiki/dailies/2026-01-03.md",
      })
      .toHaveCount(2);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: "wiki/dailies/2026-01-03.md",
      })
      .toHaveCount(1);

    await h.userCommit({
      files: {
        "wiki/dailies/2026-01-03.md": [
          "---",
          "type: daily",
          "recurrence: 2026-01-03",
          "---",
          "",
          "# 2026-01-03",
          "",
          "- [x] #followup Send Ada notes",
          "- [ ] Draft launch memo revised",
          "",
        ].join("\n"),
      },
      message: "complete followup task",
    });
    const edited = await h.tick();
    expect(edited.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: "wiki/dailies/2026-01-03.md",
      })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: "wiki/dailies/2026-01-03.md",
        objectString: "Draft launch memo revised",
      })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: "wiki/dailies/2026-01-03.md",
        objectString: "#followup Send Ada notes",
      })
      .toHaveCount(0);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: "wiki/dailies/2026-01-03.md",
      })
      .toHaveCount(0);

    await h.userCommit({
      files: {
        "wiki/dailies/2026-01-03.md": null,
      },
      message: "delete daily task page",
    });
    const deleted = await h.tick();
    expect(deleted.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: "wiki/dailies/2026-01-03.md",
      })
      .toHaveCount(0);

    await h
      .expectLedger({ processorId: "dome.daily.task-index" })
      .toAllHaveStatus("succeeded");
  },
);

scenario(
  {
    name: "effect-kinds: dome.daily.task-index extracts directives and asks on ambiguous followups",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "question" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "graph.write" },
      { kind: "capability", capability: "question.ask" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: ["dome.daily"],
      initialFiles: {
        ".dome/config.yaml": CONFIG,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const path = "wiki/dailies/2026-01-04.md";
    await h.userCommit({
      files: {
        [path]: [
          "---",
          "type: daily",
          "recurrence: 2026-01-04",
          "---",
          "",
          "# 2026-01-04",
          "",
          "TODO: Send budget update",
          "Follow up: Confirm Q3 plan with Eli",
          "We should follow up with Sam about hiring",
          "",
        ].join("\n"),
      },
      message: "add daily directives",
    });
    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: path,
      })
      .toHaveCount(2);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: path,
        objectString: "Send budget update",
      })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.open_task",
        subjectId: path,
        objectString: "Confirm Q3 plan with Eli",
      })
      .toHaveCount(1);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: path,
        objectString: "Confirm Q3 plan with Eli",
      })
      .toHaveCount(1);

    await h.expectProjection().questions().toHaveCount(1);
    await h
      .expectProjection()
      .questions()
      .toContainQuestion("Possible follow-up");
    await h
      .expectProjection()
      .questions()
      .toContainQuestion("We should follow up with Sam about hiring");

    expect(
      sourceRefRowsForFacts(h, {
        predicate: "dome.daily.open_task",
        subjectId: path,
      }).every((refs) => hasSourceRef(refs, path)),
    ).toBe(true);
    expect(
      sourceRefRowsForFacts(h, {
        predicate: "dome.daily.followup",
        subjectId: path,
      }).every((refs) => hasSourceRef(refs, path)),
    ).toBe(true);
    expect(
      sourceRefRowsForQuestions(h).every((refs) => hasSourceRef(refs, path)),
    ).toBe(true);

    await h.userCommit({
      files: {
        [path]: [
          "---",
          "type: daily",
          "recurrence: 2026-01-04",
          "---",
          "",
          "# 2026-01-04",
          "",
          "TODO: Send budget update",
          "Follow up: Confirm Q3 plan with Eli",
          "Follow up: Check in with Sam about hiring",
          "",
        ].join("\n"),
      },
      message: "clarify ambiguous followup",
    });
    const clarified = await h.tick();
    expect(clarified.adopted).toBe(true);

    await h.expectProjection().questions().toHaveCount(0);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.daily.followup",
        subjectId: path,
        objectString: "Check in with Sam about hiring",
      })
      .toHaveCount(1);
  },
);

type SourceRefRow = {
  readonly source_refs: string;
};

type SourceRefProjection = {
  readonly path?: unknown;
  readonly range?: {
    readonly startLine?: unknown;
    readonly endLine?: unknown;
  };
};

function sourceRefRowsForFacts(
  h: Harness,
  filter: { readonly predicate: string; readonly subjectId: string },
): ReadonlyArray<ReadonlyArray<SourceRefProjection>> {
  return h.projection.raw
    .query<SourceRefRow, [string, string]>(
      "SELECT source_refs FROM facts WHERE predicate = ? AND subject_id = ?",
    )
    .all(filter.predicate, filter.subjectId)
    .map((row) => JSON.parse(row.source_refs) as SourceRefProjection[]);
}

function sourceRefRowsForQuestions(
  h: Harness,
): ReadonlyArray<ReadonlyArray<SourceRefProjection>> {
  return h.projection.raw
    .query<SourceRefRow, []>("SELECT source_refs FROM questions")
    .all()
    .map((row) => JSON.parse(row.source_refs) as SourceRefProjection[]);
}

function hasSourceRef(
  refs: ReadonlyArray<SourceRefProjection>,
  path: string,
): boolean {
  return refs.some(
    (ref) =>
      ref.path === path &&
      ref.range !== undefined &&
      typeof ref.range.startLine === "number" &&
      typeof ref.range.endLine === "number",
  );
}
